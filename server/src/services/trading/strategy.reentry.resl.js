const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const { getISTTime, getISTExchangeFormat } = require("./strategy.time");

async function handleReentryReSL({ leg, config, strategyId, addStrategyLog, currentTick }) {
    const rtp = leg.resl_trigger_price;
    addStrategyLog(strategyId, `Re-Entry (SL Hit Basis) for ${leg.instrument.symbol}: Price ₹${currentTick} crossed Target ₹${rtp}. Re-entering...`, "INFO");
    leg.reentry_count = (leg.reentry_count || 0) + 1;
    let targetPrice = rtp;

    if (leg.leg.resl_mntm_enabled) {
        console.log(`[RE-SL] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target Price (${rtp}) Reached. Calculating MTP...`);
        const mntmMode = leg.leg.resl_mntm_mode || "RESL_PLUS_PCT";
        const mntmVal = parseFloat(leg.leg.resl_mntm_value || 0);
        let mtp = rtp;

        if (mntmMode === "RESL_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = rtp + (rtp * mntmVal / 100);
        else if (mntmMode === "RESL_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = rtp + mntmVal;
        else if (mntmMode === "RESL_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
        else if (mntmMode === "RESL_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = rtp - mntmVal;

        targetPrice = roundToTick(mtp);
        leg.mtp = targetPrice;
    } else {
        console.log(`[RE-SL] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target Price (${rtp}) Reached. Placing order...`);
        leg.mtp = null;
    }

    // Determine Stoploss vs Limit
    let variety = config.variety || "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    const offsetAmt = config.is_paper_trading ? 0 : getLimitOffsetAmt(targetPrice, config);
    let finalPriceStr = targetPrice.toString();
    let triggerPriceStr = targetPrice.toString();
    const side = leg.leg.side;

    if (leg.leg.resl_mntm_enabled) {
        if (side === "SELL") {
            if (targetPrice < currentTick) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(targetPrice - offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                triggerPriceStr = "0"; // Normal limit doesn't need trigger
                finalPriceStr = roundToTick(targetPrice - offsetAmt).toString();
            }
        } else if (side === "BUY") {
            if (targetPrice > currentTick) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(targetPrice + offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                triggerPriceStr = "0";
                finalPriceStr = roundToTick(targetPrice + offsetAmt).toString();
            }
        }
    } else {
        // Non-Momentum Flow: Condition met, place normal limit order
        variety = "NORMAL";
        ordertype = "LIMIT";
        triggerPriceStr = "0";
        if (side === "BUY") {
            finalPriceStr = roundToTick(targetPrice + offsetAmt).toString();
        } else {
            finalPriceStr = roundToTick(targetPrice - offsetAmt).toString();
        }
    }

    try {

        console.log(`[RE-SL] Firing Order for ${leg.instrument.symbol}. Target=${targetPrice}, LTP=${currentTick}, Var/Type=${variety}/${ordertype}`);
        const reEntryOrder = await placeOrder(
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

        leg.orderId = reEntryOrder.orderid;
        leg.uniqueOrderId = reEntryOrder.uniqueorderid;
        leg.rtp = rtp;

        leg.state = "WAITING_FOR_FILL";
        setTimeout(async () => {
            try {
                const fill = await waitForOrderFillPrice(
                    leg.uniqueOrderId,
                    config.connectionId,
                    config.is_paper_trading === true,
                    leg.instrument,
                    28800000,
                    1000,
                    {
                        side: side,
                        ordertype: ordertype,
                        price: parseFloat(finalPriceStr || 0),
                        triggerprice: parseFloat(triggerPriceStr || 0)
                    }
                );
                if (fill) {
                    leg.entryPrice = fill;
                    leg.entryTime = getISTExchangeFormat();
                    leg.original_traded_price = leg.entryPrice;
                    leg.peakPrice = leg.entryPrice;
                    leg.tslReferencePrice = leg.entryPrice;
                    leg.state = "ACTIVE";
                    addStrategyLog(strategyId, `[RE-SL] Re-entry filled for ${leg.instrument.symbol} at ₹${leg.entryPrice}.`, "INFO");

                    // Redeploy exchange SL if needed
                    const isSlEnabled = leg.leg.reentry_sl_enabled ? true : leg.leg.sl_enabled !== false;
                    if (config.variety === "STOPLOSS" && leg.entryPrice && isSlEnabled) {
                        const activeSlType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                        const activeSlValue = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : leg.leg.stop_loss;

                        const slOrder = await placeStopLossWithRetry({
                            baseConfig: config,
                            legSide: leg.leg.side,
                            entryPrice: leg.entryPrice,
                            instrument: leg.instrument,
                            lots: leg.leg.lots,
                            slType: activeSlType,
                            slValue: activeSlValue,
                            slLimitMargin: config.entry_limit_offset,
                            slLimitMarginType: config.entry_limit_offset_type || 'POINTS',
                            connectionId: config.connectionId,
                            strategyId: strategyId
                        });

                        const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, activeSlType, activeSlValue, getLimitOffsetAmt(leg.entryPrice, config), config.entry_limit_offset_type || 'POINTS');
                        if (slOrder?.orderid) {
                            leg.slOrderId = slOrder.orderid;
                            leg.slUniqueOrderId = slOrder.uniqueorderid;
                        } else {
                            addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for ${leg.instrument.symbol} (RE-SL Entry).`, "WARNING");
                        }
                        leg.slTriggerPrice = prices?.trigger;
                        leg.initialSlTriggerPrice = prices?.trigger;
                        leg.slLimitPrice = prices?.limit;
                        leg.exchangeSlProcessed = false;
                    }
                }
            } catch (e) {
                console.error("[RE-SL] Fill monitoring failed:", e.message);
            }
        }, 0);
    } catch (err) {
        if (err.message === "LPP_TRIGGER_REJECTION") {
            addStrategyLog(strategyId, `[RE-SL] Target order rejected by LPP for ${leg.instrument.symbol}. Switching to INTERNAL MONITORING for Target: ₹${targetPrice}.`, "WARNING");
            leg.state = "WAITING_FOR_INTERNAL_FALLBACK";
            leg.fallbackTargetPrice = targetPrice;
            leg.fallbackSide = side;
            return;
        }
        console.error("[RE-SL] Momentum Re-entry failed. Halting leg completely.", err);
        leg.state = "COMPLETED";
        leg.exited = true;
    }
}

module.exports = {
    handleReentryReSL
};
