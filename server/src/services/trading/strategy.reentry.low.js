const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const { roundToTick, computeStopLossExitPrices, getLimitOffsetAmt } = require("./strategy.offset");
const { getISTTime } = require("./strategy.time");
const { getAuthorizedInstance } = require("../../config/smartapi");

/**
 * Handles re-entry for "RE LOW" mode.
 */
async function handleReentryLow({ leg, config, strategyId, addStrategyLog, currentTick, isMtpPlacement = false }) {
    // 1. Setup the basic details
    const side = leg.leg.side;
    const rtp = leg.re_low_trigger_price; 
    const currentPrice = currentTick || leg.currentLtp;
    const offsetAmt = getLimitOffsetAmt(rtp, config);

    // 2. Decide the Target Price (MTP or RTP)
    let targetPrice = rtp;
    if (leg.leg.relow_mntm_enabled) {
        const mntmMode = leg.leg.relow_mntm_mode || "RELOW_PLUS_PCT";
        const mntmVal = parseFloat(leg.leg.relow_mntm_value || 0);
        let mtp = rtp;
        if (mntmMode === "RELOW_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = rtp + (rtp * mntmVal / 100);
        else if (mntmMode === "RELOW_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = rtp + mntmVal;
        else if (mntmMode === "RELOW_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
        else if (mntmMode === "RELOW_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = rtp - mntmVal;
        
        targetPrice = roundToTick(mtp);
        leg.mtp = targetPrice; // Set MTP for frontend display
    } else {
        leg.mtp = null; // Clear MTP if disabled
    }

    // Recalculate offset based on the final targetPrice
    const finalOffsetAmt = getLimitOffsetAmt(targetPrice, config);

    // 3. Determine Order Type (STOPLOSS vs LIMIT)
    let variety = config.variety || "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    let finalPriceStr = targetPrice.toString();
    let triggerPriceStr = targetPrice.toString();

    if (leg.leg.relow_mntm_enabled) {
        if (side === "SELL") {
            if (targetPrice < currentPrice) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(targetPrice - finalOffsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                triggerPriceStr = "0"; // Normal limit doesn't need trigger
                finalPriceStr = roundToTick(targetPrice - finalOffsetAmt).toString();
            }
        } else if (side === "BUY") {
            if (targetPrice > currentPrice) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(targetPrice + finalOffsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                triggerPriceStr = "0";
                finalPriceStr = roundToTick(targetPrice + finalOffsetAmt).toString();
            }
        }
    } else {
        // Non-Momentum Flow: We waited for pullback, so just place a resting LIMIT order
        variety = "NORMAL";
        ordertype = "LIMIT";
        triggerPriceStr = "0";
        if (side === "BUY") {
            finalPriceStr = roundToTick(targetPrice + finalOffsetAmt).toString();
        } else {
            finalPriceStr = roundToTick(targetPrice - finalOffsetAmt).toString();
        }
    }

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
        leg.rtp = rtp; // Sync RTP for frontend display
        
        // If this is MTP placement, we move to FILL state
        if (isMtpPlacement) {
            leg.state = "ACTIVE"; 
            addStrategyLog(strategyId, `[RE-LOW] MTP Order placed for ${leg.instrument?.symbol} at ₹${targetPrice}.`, "INFO");
        } else {
            addStrategyLog(strategyId, `[RE-LOW] Resting Limit placed for ${leg.instrument?.symbol} at ₹${finalPriceStr}.`, "INFO");
        }

        // Wait for fill in the background
        monitorReentryFill(leg, config, strategyId, addStrategyLog, {
            side: side,
            ordertype: ordertype,
            price: parseFloat(finalPriceStr),
            triggerprice: parseFloat(triggerPriceStr)
        });

    } catch (err) {
        if (err.message === "LPP_TRIGGER_REJECTION") {
            addStrategyLog(strategyId, `[RE-LOW] MTP order rejected by LPP for ${leg.instrument?.symbol}. Switching to INTERNAL MONITORING for Target: ₹${targetPrice}.`, "WARNING");
            leg.state = "WAITING_FOR_INTERNAL_FALLBACK";
            leg.fallbackTargetPrice = targetPrice;
            leg.fallbackSide = side;
            return;
        }
        console.error("[RE-LOW] Order placement failed:", err.message);
        addStrategyLog(strategyId, `[RE-LOW] Failed to place re-entry: ${err.message}`, "ERROR");
    }
}

/**
 * Modifies an existing re-entry order if the market low price changes.
 */
async function modifyReentryLowOrder({ leg, config, strategyId, addStrategyLog, newRtp }) {
    if (config.is_paper_trading) {
        leg.re_low_trigger_price = newRtp;
        addStrategyLog(strategyId, `[PAPER] Moved RE-LOW Resting Limit to ₹${newRtp}`, "INFO");
        return;
    }

    try {
        const api = await getAuthorizedInstance(config.connectionId);
        const offsetAmt = getLimitOffsetAmt(newRtp, config);
        const side = leg.leg.side;
        const newPrice = side === "BUY" ? roundToTick(newRtp + offsetAmt) : roundToTick(newRtp - offsetAmt);

        const quantityInShares = (leg.leg.lots * parseInt(leg.instrument.lotsize)).toString();
        await api.modifyOrder({
            variety: "NORMAL",
            orderid: leg.orderId,
            ordertype: "LIMIT",
            producttype: config.producttype || "INTRADAY",
            duration: config.duration || "DAY",
            price: newPrice.toString(),
            quantity: quantityInShares,
            tradingsymbol: leg.instrument.symbol,
            symboltoken: leg.instrument.token,
            exchange: leg.instrument.exch_seg
        });

        leg.re_low_trigger_price = newRtp;
        addStrategyLog(strategyId, `[RE-LOW] Modified Resting Order for ${leg.instrument.symbol} to ₹${newPrice}`, "INFO");
    } catch (err) {
        console.error("[RE-LOW] Modification failed:", err.message);
    }
}

/**
 * Background helper to watch for fills and redeploy SL.
 */
async function monitorReentryFill(leg, config, strategyId, addStrategyLog, orderDetails = null) {
    const { waitForOrderFillPrice } = require("./strategy.execution");
    
    try {
        const fill = await waitForOrderFillPrice(
            leg.uniqueOrderId,
            config.connectionId,
            config.is_paper_trading === true,
            leg.instrument,
            28800000, 
            1000,
            orderDetails
        );

        if (fill) {
            // Snapshot the low reached during the wait period for display/history
            leg.final_low_reached = leg.max_low_price;
            
            leg.state = "ACTIVE";
            leg.entryPrice = fill;
            leg.entryTime = getISTTime();
            leg.original_traded_price = fill;
            leg.tslReferencePrice = fill;
            leg.reentry_count = (leg.reentry_count || 0) + 1;
            addStrategyLog(strategyId, `[RE-LOW] Re-entry filled for ${leg.instrument.symbol} at ₹${fill}. Low reached: ₹${leg.final_low_reached}`, "INFO");

            // Redeploy SL
            deployReentrySL(leg, config, strategyId, addStrategyLog);
        }
    } catch (e) {
        console.error("[RE-LOW] Fill monitoring error:", e.message);
    }
}

async function deployReentrySL(leg, config, strategyId, addStrategyLog) {
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
            leg.initialSlTriggerPrice = prices?.trigger;
            leg.slLimitPrice = prices?.limit;
        }
    }
}

module.exports = { handleReentryLow, modifyReentryLowOrder };
