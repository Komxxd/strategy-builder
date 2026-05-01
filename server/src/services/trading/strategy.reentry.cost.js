const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");
const { getISTTime } = require("./strategy.time");

async function handleReentryCost({ leg, config, strategyId, addStrategyLog, currentTick }) {
    const rtp = leg.recost_trigger_price;
    console.log(`[RE-COST MNTM] Condition met for ${leg.instrument.symbol} at ${currentTick}! Target RTP (${rtp}) Reached. Calculating MTP...`);
    addStrategyLog(strategyId, `Momentum Hit for ${leg.instrument.symbol}: Price ₹${currentTick} crossed RTP ₹${rtp}. Re-entering...`, "INFO");
    
    leg.reentry_count++;

    // Calculate MTP (Mntm Trigger Price) from RTP
    const mntmMode = leg.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
    const mntmVal = parseFloat(leg.leg.recost_mntm_value || 0);
    let mtp = rtp;

    if (mntmMode === "RECOST_PLUS_PCT") mtp = rtp + (rtp * mntmVal / 100);
    else if (mntmMode === "RECOST_PLUS_PTS") mtp = rtp + mntmVal;
    else if (mntmMode === "RECOST_MINUS_PCT") mtp = rtp - (rtp * mntmVal / 100);
    else if (mntmMode === "RECOST_MINUS_PTS") mtp = rtp - mntmVal;

    const roundedMtp = roundToTick(mtp);

    // Determine Stoploss vs Limit
    let variety = config.variety || "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    const offsetAmt = getLimitOffsetAmt(roundedMtp, config);
    let finalPriceStr = roundedMtp.toString();
    let triggerPriceStr = roundedMtp.toString();
    const side = leg.leg.side;

    if (side === "SELL") {
        if (roundedMtp < currentTick) {
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            finalPriceStr = roundToTick(roundedMtp - offsetAmt).toString();
        } else {
            variety = "NORMAL";
            ordertype = "LIMIT";
            finalPriceStr = roundToTick(roundedMtp - offsetAmt).toString();
        }
    } else if (side === "BUY") {
        if (roundedMtp > currentTick) {
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            finalPriceStr = roundToTick(roundedMtp + offsetAmt).toString();
        } else {
            variety = "NORMAL";
            ordertype = "LIMIT";
            finalPriceStr = roundToTick(roundedMtp + offsetAmt).toString();
        }
    }

    try {

        console.log(`[RE-COST MNTM] Firing Order for ${leg.instrument.symbol}. MTP=${roundedMtp}, LTP=${currentTick}, Var/Type=${variety}/${ordertype}`);
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
        leg.mtp = roundedMtp;
        leg.rtp = rtp;

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
                leg.entryTime = getISTTime();
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
    } catch (err) {
        if (err.message === "LPP_TRIGGER_REJECTION") {
            addStrategyLog(strategyId, `[RE-COST] MTP order rejected by LPP for ${leg.instrument.symbol}. Switching to INTERNAL MONITORING for Target: ₹${roundedMtp}.`, "WARNING");
            leg.state = "WAITING_FOR_INTERNAL_FALLBACK";
            leg.fallbackTargetPrice = roundedMtp;
            leg.fallbackSide = side;
            return;
        }
        console.error("[RE-COST MNTM] Momentum Re-entry failed. Halting leg completely.", err);
        leg.state = "COMPLETED";
        leg.exited = true;
    }
}

module.exports = {
    handleReentryCost
};
