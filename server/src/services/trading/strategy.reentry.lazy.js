const { findClosestPremiumInstrument, getLegStrikeSelection, findOptionInstrument, calculateSyntheticFuture, getATMStrike } = require("./strategy.instruments");
const { calculateMomentumTarget } = require("./strategy.momentum");
const { getISTTime, getISTExchangeFormat, isWithinSecondsOfExit } = require("./strategy.time");
const { computeStopLossExitPrices, getLimitOffsetAmt, resolveUniversalOrderParams } = require("./strategy.offset");
const { placeOrder, resolveReentryOrderFill, isMarginError } = require("./strategy.execution");
const marketService = require("../market.service");

async function handleLazyLeg({ leg, config, strategyId, addStrategyLog }) {
    const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
    const isPaperTrading = config?.is_paper_trading === true || isVirtual;
    
    if (config?.exit_time && isWithinSecondsOfExit(getISTTime(), config.exit_time, 5)) {
        addStrategyLog(strategyId, `Skipping Lazy re-entry: within 5s of exit time (${config.exit_time})`, "INFO");
        return;
    }

    try {
        let indexToken = "99926000", indexExchange = "NSE";
        if (config.index === "BANKNIFTY") indexToken = "99926009";
        else if (config.index === "FINNIFTY") indexToken = "99926037";
        else if (config.index === "SENSEX") { indexToken = "99919000"; indexExchange = "BSE"; }

        const spotRes = await marketService.getLTP({ exchange: indexExchange, symboltoken: indexToken, connectionId: config.connectionId });
        if (!spotRes.status || !spotRes.data?.fetched?.[0]) return;
        const spotPrice = spotRes.data.fetched[0].ltp;

        let targetInstrument = null;
        if (leg.leg.strike_criteria === 'CLOSEST_PREMIUM') {
            targetInstrument = await findClosestPremiumInstrument(config.index, leg.leg.option_type, leg.leg.premium, config.connectionId, leg.leg.expiry_type);
        } else if (leg.leg.strike_criteria === 'SYNTHETIC_FUTURE') {
            const sfPrice = await calculateSyntheticFuture(config.index, spotPrice, config.connectionId, leg.leg.expiry_type);
            const { targetStrike: sfStrike } = getLegStrikeSelection({ index: config.index, option_type: leg.leg.option_type, strike: leg.leg.strike, spotPrice: sfPrice });
            targetInstrument = await findOptionInstrument(config.index, leg.leg.option_type, sfStrike, leg.leg.expiry_type);
            addStrategyLog(strategyId, `[LAZY LEG] Synthetic Future = ₹${sfPrice.toFixed(2)} → Strike ${sfStrike}`, "INFO");
        } else {
            const { targetStrike } = getLegStrikeSelection({ index: config.index, option_type: leg.leg.option_type, strike: leg.leg.strike, spotPrice });
            targetInstrument = await findOptionInstrument(config.index, leg.leg.option_type, targetStrike, leg.leg.expiry_type);
        }

        if (!targetInstrument) {
            addStrategyLog(strategyId, `Lazy Leg: Could not find instrument for ${leg.leg.option_type}. Retrying...`, "ERROR");
            return;
        }

        leg.instrument = targetInstrument;
        const instLtpRes = await marketService.getLTP({ exchange: targetInstrument.exch_seg, symboltoken: targetInstrument.token, connectionId: config.connectionId });
        const instLtp = instLtpRes.data?.fetched?.[0]?.ltp || 0;

        if (leg.leg.simple_mntm_enabled) {
            const roundedMntmTarget = calculateMomentumTarget(instLtp, leg.leg);
            leg.mntmTargetPrice = roundedMntmTarget;
            leg.baseOtp = instLtp;
            leg.state = "WAITING_FOR_SIMPLE_MNTM";
            const mntmType = leg.leg.simple_mntm_type || "NORMAL";
            if (mntmType === "HIGH") {
                leg.max_peak_price = instLtp;
                leg.re_high_trigger_price = roundedMntmTarget;
                leg.rtp = roundedMntmTarget;
            } else if (mntmType === "LOW") {
                leg.max_low_price = instLtp;
                leg.re_low_trigger_price = roundedMntmTarget;
                leg.rtp = roundedMntmTarget;
            }
            addStrategyLog(strategyId, `[LAZY LEG] ${targetInstrument.symbol} waiting for Momentum (${mntmType}) @ ₹${leg.mntmTargetPrice}`, "INFO");
        } else {
            if (isPaperTrading) {
                leg.entryPrice = instLtp;
                leg.entryTime = getISTExchangeFormat();
                leg.original_traded_price = instLtp;
                leg.state = "ACTIVE";
                leg.peakPrice = instLtp; 
                leg.tslReferencePrice = instLtp; 
                addStrategyLog(strategyId, `[LAZY LEG PAPER] ${targetInstrument.symbol} entered at ₹${instLtp}`, "INFO");
                if (config.variety === "STOPLOSS") {
                    const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss || 0, getLimitOffsetAmt(leg.entryPrice, config), 'POINTS');
                    leg.slTriggerPrice = prices?.trigger;
                    leg.initialSlTriggerPrice = prices?.trigger;
                    leg.slLimitPrice = prices?.limit;
                }
            } else {
                const offsetAmt = getLimitOffsetAmt(instLtp, config);
                const params = resolveUniversalOrderParams({ targetPrice: instLtp, currentLtp: instLtp, side: leg.leg.side, offset: offsetAmt });
                let orderRes = await placeOrder({ ...config, ...params, side: leg.leg.side, lots: leg.leg.lots }, targetInstrument, config.connectionId);
                
                if (!orderRes.uniqueorderid) {
                    addStrategyLog(strategyId, `[ERROR] Angel One API returned a partial response (missing Unique Order ID) for ${targetInstrument.symbol}. Retrying Lazy entry...`, "ERROR");
                    orderRes = await placeOrder({ ...config, ...params, side: leg.leg.side, lots: leg.leg.lots }, targetInstrument, config.connectionId);
                }

                leg.orderId = orderRes.orderid;
                leg.uniqueOrderId = orderRes.uniqueorderid;
                leg.state = "WAITING_FOR_FILL";
                addStrategyLog(strategyId, `[LAZY LEG LIVE] ${targetInstrument.symbol} placed: ${params.ordertype} @ ${params.price}`, "INFO");
                
                if (leg.uniqueOrderId) {
                    addStrategyLog(strategyId, `[Success] Angel one API returned a full response for ${targetInstrument.symbol}.`, "INFO");
                } else {
                    addStrategyLog(strategyId, `[CRITICAL] Retry failed: Angel One API returned a partial response again for ${targetInstrument.symbol}.`, "ERROR");
                    leg.state = "ERROR";
                    return;
                }

                // Background tracker for Live Fill
                setTimeout(async () => {
                    const { placeStopLossWithRetry } = require("./strategy.execution");
                    try {
                        const { fillPrice, fillMeta, halted } = await resolveReentryOrderFill({
                            leg,
                            config,
                            strategyId,
                            side: leg.leg.side,
                            variety: params.variety || "NORMAL",
                            ordertype: params.ordertype,
                            targetPrice: instLtp,
                            priceStr: params.price,
                            triggerPriceStr: params.triggerprice,
                            isPaperTrading: false,
                            isInstantFill: true,
                            isReentryChase: false,
                            timeoutMs: 60000,
                            pollMs: 2000,
                            logPrefix: "[LAZY LEG LIVE]"
                        });
                        if (halted) return;

                        if (fillPrice) {
                            leg.entryPrice = fillPrice;
                            leg.entryTime = fillMeta.time || getISTExchangeFormat();
                            leg.original_traded_price = fillPrice;
                            leg.peakPrice = fillPrice;
                            leg.tslReferencePrice = fillPrice;
                            leg.state = "ACTIVE";
                            addStrategyLog(strategyId, `[LAZY LEG LIVE] ${leg.instrument.symbol} fill confirmed at ₹${fillPrice}`, "INFO");

                            if (config.variety === "STOPLOSS") {
                                let slValueToUse = leg.leg.stop_loss || 0;
                                if (leg.leg.sl_multiplier_entry_candle && leg.leg.sl_multiplier_value) {
                                    slValueToUse = (leg.leg.stop_loss || 0) * parseFloat(leg.leg.sl_multiplier_value);
                                    leg.sl_multiplier_applied = true;
                                }

                                const slOrder = await placeStopLossWithRetry({
                                    baseConfig: config, legSide: leg.leg.side, entryPrice: leg.entryPrice, instrument: leg.instrument, lots: leg.leg.lots,
                                    slType: leg.leg.sl_type || "PERCENTAGE", slValue: slValueToUse, slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                                    slLimitMarginType: config.entry_limit_offset_type || 'POINTS', connectionId: config.connectionId, strategyId: strategyId
                                });
                                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", slValueToUse, getLimitOffsetAmt(leg.entryPrice, config), config.entry_limit_offset_type || 'POINTS');
                                if (slOrder?.orderid) {
                                    leg.slOrderId = slOrder.orderid;
                                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                                }
                                leg.slTriggerPrice = prices?.trigger;
                                leg.initialSlTriggerPrice = prices?.trigger;
                                leg.slLimitPrice = prices?.limit;
                            }
                        }
                    } catch (e) {
                         addStrategyLog(strategyId, `[LAZY LEG LIVE] Fill tracking failed for ${leg.instrument?.symbol}: ${e.message}`, "ERROR");
                    }
                }, 1000);
            }
        }
    } catch (e) {
        console.error("Lazy Leg Handler Error", e);
        if (isMarginError(e)) {
            leg.state = "COMPLETED";
            leg.exited = true;
            const { squareOffAndStopOnMarginError } = require("./strategy.lifecycle");
            await squareOffAndStopOnMarginError(strategyId, `Margin Error in Lazy Leg for ${leg.instrument?.symbol || "leg"}: ${e.message}`);
        }
    }
}

module.exports = {
    handleLazyLeg
};
