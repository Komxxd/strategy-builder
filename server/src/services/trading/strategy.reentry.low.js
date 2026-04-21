const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const { roundToTick, computeStopLossExitPrices, getLimitOffsetAmt } = require("./strategy.offset");
const { getISTTime } = require("./strategy.time");

/**
 * Handles re-entry for "RE LOW" mode.
 * Identical to RE HIGH but triggers relative to the minimum price (LTP Low) seen since stop-loss.
 */
async function handleReentryLow({ leg, config, strategyId, addStrategyLog, currentTick }) {
    if (leg.state !== "WAITING_FOR_RE_LOW") return;

    // Increment re-entry count
    leg.reentry_count = (leg.reentry_count || 0) + 1;
    
    // Proactively set state to ACTIVE to prevent duplicate triggers
    leg.state = "ACTIVE";
    leg.exited = false;
    leg.exitType = null;
    leg.isExiting = false;
    leg.entryPrice = null;
    leg.orderId = null;
    leg.uniqueOrderId = null;
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;
    const side = leg.leg.side;
    const rtp = leg.re_low_trigger_price; 
    const currentPrice = currentTick || leg.currentLtp;

    console.log(`[RE-LOW] Triggered for ${leg.instrument?.symbol}. Low Price was ${leg.max_low_price}. Current LTP=${currentPrice}`);
    addStrategyLog(strategyId, `[RE-LOW] Triggered for ${leg.instrument?.symbol}. Low Price was ${leg.max_low_price}. Current LTP=${currentPrice}`, "INFO");

    let mtp = rtp;
    if (leg.leg.relow_mntm_enabled) {
        const mntmMode = leg.leg.relow_mntm_mode || "RELOW_PLUS_PCT";
        const mntmVal = leg.leg.relow_mntm_value || 0;
        
        if (mntmMode === "RELOW_PLUS_PCT") mtp = rtp + (rtp * mntmVal / 100);
        else if (mntmMode === "RELOW_PLUS_PTS") mtp = rtp + mntmVal;
        else if (mntmMode === "RELOW_MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
        else if (mntmMode === "RELOW_MINUS_PTS") mtp = rtp - mntmVal;
    }
    mtp = roundToTick(mtp);

    let variety = config.variety || "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    const offsetAmt = getLimitOffsetAmt(mtp, config);

    let finalPriceStr = mtp.toString();
    let triggerPriceStr = mtp.toString();

    // Determine order type based on LTP vs MTP
    if (side === "SELL") {
        if (mtp < currentPrice) {
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            finalPriceStr = roundToTick(mtp - offsetAmt).toString();
            triggerPriceStr = mtp.toString();
        } else {
            variety = "NORMAL";
            ordertype = "LIMIT";
            finalPriceStr = roundToTick(mtp - offsetAmt).toString();
        }
    } else if (side === "BUY") {
        if (mtp > currentPrice) {
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            finalPriceStr = roundToTick(mtp + offsetAmt).toString();
            triggerPriceStr = mtp.toString();
        } else {
            variety = "NORMAL";
            ordertype = "LIMIT";
            finalPriceStr = roundToTick(mtp + offsetAmt).toString();
        }
    }

    leg.exited = false;
    leg.exitType = null;
    leg.isExiting = false;
    leg.entryPrice = null;
    leg.orderId = null;
    leg.uniqueOrderId = null;
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;

    try {
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

        // Reset low tracking for the new trade
        leg.max_low_price = 0;

        // Wait for fill
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
                        triggerprice: parseFloat(triggerPriceStr || 0),
                        isInstantFill: false
                    }
                );
                leg.entryPrice = fill || currentPrice;
                leg.entryTime = getISTTime();
                leg.original_traded_price = leg.entryPrice;
            } catch (e) {
                leg.entryPrice = currentPrice;
                leg.entryTime = getISTTime();
            }

            // Redeploy SL
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

                if (slOrder?.orderid) {
                    const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset, config.entry_limit_offset_type || 'POINTS');
                    leg.slOrderId = slOrder.orderid;
                    leg.slUniqueOrderId = slOrder.uniqueorderid;
                    leg.slTriggerPrice = prices?.trigger;
                    leg.slLimitPrice = prices?.limit;
                    leg.exchangeSlProcessed = false;
                }
            }
        }, 1000);

    } catch (err) {
        console.error("[RE-LOW] Re-entry failed:", err);
        addStrategyLog(strategyId, `[RE-LOW] Re-entry failed for ${leg.instrument?.symbol}: ${err.message}`, "ERROR");
        leg.state = "COMPLETED";
        leg.exited = true;
    }
}

module.exports = { handleReentryLow };
