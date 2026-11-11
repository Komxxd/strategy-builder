const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, placeStopLossWithRetry, resolveReentryOrderFill, handleReentryPlacementError } = require("./strategy.execution");
const { getISTTime, getISTExchangeFormat, isWithinSecondsOfExit } = require("./strategy.time");

async function handleReentryCost({ leg, config, strategyId, addStrategyLog, currentTick }) {
    const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
    const isPaperTrading = config?.is_paper_trading === true || isVirtual;
    
    if (config?.exit_time && isWithinSecondsOfExit(getISTTime(), config.exit_time, 5)) {
        addStrategyLog(strategyId, `Skipping Cost re-entry: within 5s of exit time (${config.exit_time})`, "INFO");
        return;
    }
    const rtp = leg.recost_trigger_price;
    addStrategyLog(strategyId, `Momentum Hit for ${leg.instrument.symbol}: Price ₹${currentTick} crossed RTP ₹${rtp}. Re-entering...`, "INFO");
    leg.reentry_count = (leg.reentry_count || 0) + 1;
    let targetPrice = rtp;

    if (leg.leg.recost_mntm_enabled) {
        console.log(`[RE-COST MNTM] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target RTP (${rtp}) Reached. Calculating MTP...`);
        const mntmMode = leg.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
        const mntmVal = parseFloat(leg.leg.recost_mntm_value || 0);
        let mtp = rtp;

        if (mntmMode === "RECOST_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = rtp + (rtp * mntmVal / 100);
        else if (mntmMode === "RECOST_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = rtp + mntmVal;
        else if (mntmMode === "RECOST_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
        else if (mntmMode === "RECOST_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = rtp - mntmVal;

        targetPrice = roundToTick(mtp);
        leg.mtp = targetPrice;
    } else {
        console.log(`[RE-COST MNTM] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target RTP (${rtp}) Reached. Placing order...`);
        leg.mtp = null;
    }

    let variety = "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    const offsetAmt = isPaperTrading ? 0 : getLimitOffsetAmt(targetPrice, config);
    let finalPriceStr = targetPrice.toString();
    let triggerPriceStr = "0";
    const side = leg.leg.side;

    if (ordertype === "LIMIT") {
        if (side === "BUY") {
            finalPriceStr = roundToTick(targetPrice + offsetAmt).toString();
        } else {
            finalPriceStr = roundToTick(targetPrice - offsetAmt).toString();
        }
    } else {
        finalPriceStr = "0";
    }

    try {

        console.log(`[RE-COST MNTM] Firing Order for ${leg.instrument.symbol}. Target=${targetPrice}, LTP=${currentTick}, Var/Type=${variety}/${ordertype}`);
        let reEntryOrder = await placeOrder(
            {
                ...config,
                side: side,
                variety: variety,
                ordertype: ordertype,
                price: finalPriceStr,
                triggerprice: triggerPriceStr,
                lots: leg.leg.lots
            },
            leg.instrument,
            config.connectionId
        );
        
        if (!reEntryOrder.uniqueorderid) {
            addStrategyLog(strategyId, `[ERROR] Angel One API returned a partial response (missing Unique Order ID) for ${leg.instrument.symbol}. Retrying Cost entry...`, "ERROR");
            reEntryOrder = await placeOrder(
                {
                    ...config,
                    side: side,
                    variety: variety,
                    ordertype: ordertype,
                    price: finalPriceStr,
                    triggerprice: triggerPriceStr,
                    lots: leg.leg.lots
                },
                leg.instrument,
                config.connectionId
            );
        }

        leg.orderId = reEntryOrder.orderid;
        leg.uniqueOrderId = reEntryOrder.uniqueorderid;
        
        leg.state = "WAITING_FOR_FILL";
        addStrategyLog(strategyId, `[RE-COST] Resting Limit placed for ${leg.instrument?.symbol} at ₹${finalPriceStr}.`, "INFO");

        if (leg.uniqueOrderId) {
            addStrategyLog(strategyId, `[Success] Angel one API returned a full response for ${leg.instrument.symbol}.`, "INFO");
        } else {
            addStrategyLog(strategyId, `[CRITICAL] Retry failed: Angel One API returned a partial response again for ${leg.instrument.symbol}.`, "ERROR");
            leg.state = "ERROR";
            return;
        }
        
        leg.rtp = rtp;
        setTimeout(async () => {
            try {
                const { fillPrice, fillMeta, halted } = await resolveReentryOrderFill({
                    leg,
                    config,
                    strategyId,
                    side,
                    variety,
                    ordertype,
                    targetPrice,
                    priceStr: finalPriceStr,
                    triggerPriceStr: triggerPriceStr,
                    isPaperTrading,
                    isInstantFill: isPaperTrading,
                    isReentryChase: true,
                    timeoutMs: 28800000,
                    pollMs: 1000,
                    logPrefix: "[RE-COST]"
                });
                if (halted) return;

                if (fillPrice) {
                    const fill = fillPrice;
                    leg.entryPrice = fill;
                    leg.entryTime = fillMeta.time || getISTExchangeFormat();
                    leg.original_traded_price = leg.entryPrice;
                    leg.peakPrice = leg.entryPrice;
                    leg.tslReferencePrice = fill;
                    leg.state = "ACTIVE";
                    addStrategyLog(strategyId, `[RE-COST] Re-entry filled for ${leg.instrument.symbol} at ₹${leg.entryPrice}.`, "INFO");

                    // Redeploy exchange SL if needed
                    const isSlEnabled = leg.leg.reentry_sl_enabled ? true : leg.leg.sl_enabled !== false;
                    if (config.variety === "STOPLOSS" && leg.entryPrice && isSlEnabled) {
                        const activeSlType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                        const activeSlValue = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : leg.leg.stop_loss;

                        let slValueToUse = activeSlValue;
                        if (leg.leg.reentry_sl_multiplier_entry_candle && leg.leg.reentry_sl_multiplier_value) {
                            slValueToUse = activeSlValue * parseFloat(leg.leg.reentry_sl_multiplier_value);
                            leg.sl_multiplier_applied = true;
                        }

                        const slOrder = await placeStopLossWithRetry({
                            baseConfig: config,
                            legSide: leg.leg.side,
                            entryPrice: leg.entryPrice,
                            instrument: leg.instrument,
                            lots: leg.leg.lots,
                            slType: activeSlType,
                            slValue: slValueToUse,
                            slLimitMargin: config.entry_limit_offset,
                            slLimitMarginType: config.entry_limit_offset_type || 'POINTS',
                            connectionId: config.connectionId,
                            strategyId: strategyId
                        });

                        const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, activeSlType, slValueToUse, getLimitOffsetAmt(leg.entryPrice, config), config.entry_limit_offset_type || 'POINTS');
                        if (slOrder?.orderid) {
                            leg.slOrderId = slOrder.orderid;
                            leg.slUniqueOrderId = slOrder.uniqueorderid;
                        } else if (!slOrder?.deferred) {
                            addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for ${leg.instrument.symbol} (RE-COST Entry).`, "WARNING");
                        }
                        leg.slTriggerPrice = prices?.trigger;
                        leg.initialSlTriggerPrice = prices?.trigger;
                        leg.slLimitPrice = prices?.limit;
                        leg.exchangeSlProcessed = false;
                    }
                }
            } catch (e) {
                console.error("[RE-COST] Fill monitoring failed:", e.message);
            }
        }, 0);
    } catch (err) {
        await handleReentryPlacementError({
            err,
            strategyId,
            leg,
            targetPrice,
            side,
            logPrefix: "[RE-COST]"
        });
    }
}

module.exports = {
    handleReentryCost
};
