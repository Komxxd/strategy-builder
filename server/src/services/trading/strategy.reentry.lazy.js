const { findClosestPremiumInstrument, getLegStrikeSelection, findOptionInstrument } = require("./strategy.instruments");
const { calculateMomentumTarget } = require("./strategy.momentum");
const { getISTTime } = require("./strategy.time");
const { computeStopLossExitPrices, getLimitOffsetAmt, resolveUniversalOrderParams } = require("./strategy.offset");
const { placeOrder } = require("./strategy.execution");
const marketService = require("../market.service");

async function handleLazyLeg({ leg, config, strategyId, addStrategyLog }) {
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
            addStrategyLog(strategyId, `[LAZY LEG] ${targetInstrument.symbol} waiting for Momentum @ ₹${leg.mntmTargetPrice}`, "INFO");
        } else {
            if (config.is_paper_trading) {
                leg.entryPrice = instLtp;
                leg.entryTime = getISTTime();
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
                const orderRes = await placeOrder({ ...config, ...params, side: leg.leg.side, lots: leg.leg.lots }, targetInstrument, config.connectionId);
                leg.orderId = orderRes.orderid;
                leg.uniqueOrderId = orderRes.uniqueorderid;
                leg.state = "WAITING_FOR_FILL";
                addStrategyLog(strategyId, `[LAZY LEG LIVE] ${targetInstrument.symbol} placed: ${params.ordertype} @ ${params.price}`, "INFO");

                // Background tracker for Live Fill
                setTimeout(async () => {
                    const { waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
                    try {
                        const fill = await waitForOrderFillPrice(
                            leg.uniqueOrderId,
                            config.connectionId,
                            false,
                            leg.instrument,
                            60000,
                            2000,
                            { ...params, side: leg.leg.side, isInstantFill: true }
                        );
                        
                        if (fill) {
                            const fillPrice = fill;
                            leg.entryPrice = fillPrice;
                            leg.entryTime = getISTTime();
                            leg.original_traded_price = fillPrice;
                            leg.peakPrice = fillPrice;
                            leg.tslReferencePrice = fillPrice;
                            leg.state = "ACTIVE";
                            addStrategyLog(strategyId, `[LAZY LEG LIVE] ${leg.instrument.symbol} fill confirmed at ₹${fillPrice}`, "INFO");

                            if (config.variety === "STOPLOSS") {
                                const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss || 0, getLimitOffsetAmt(leg.entryPrice, config), config.entry_limit_offset_type || 'POINTS');
                                const slOrder = await placeStopLossWithRetry({
                                    baseConfig: config, legSide: leg.leg.side, entryPrice: leg.entryPrice, instrument: leg.instrument, lots: leg.leg.lots,
                                    slType: leg.leg.sl_type || "PERCENTAGE", slValue: leg.leg.stop_loss, slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                                    slLimitMarginType: config.entry_limit_offset_type || 'POINTS', connectionId: config.connectionId, strategyId: strategyId
                                });
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
    }
}

module.exports = {
    handleLazyLeg
};
