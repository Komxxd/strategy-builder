/**
 * STRATEGY LIFECYCLE SERVICE
 * ==========================
 * This service is the "brain" that manages the state transitions of a trade leg.
 * It is primarily responsible for what happens AFTER a trade is closed (Stop-Loss or Target).
 * 
 * Flow:
 * 1. A leg hits its Stop-Loss (detected by strategy.monitor.js).
 * 2. This service is called via `handleLegStopOut`.
 * 3. It records the final PnL (Profit/Loss).
 * 4. It decides which Re-Entry logic to trigger (RE-COST, RE-SL, RE-HIGH, etc.).
 */

const { getISTTime } = require("./strategy.time");
const { addStrategyLog, activeStrategies, updateStrategyInMemory } = require("./strategy.state");
const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");

/**
 * Handles the complete "Exit" process of a single leg.
 * @param {Object} leg - The current trade leg being closed.
 * @param {String} exitType - Why the trade closed (e.g., 'STOPLOSS', 'SQUARE_OFF').
 * @param {Object} strategy - The parent strategy object.
 */
async function handleLegStopOut(leg, exitType, strategy) {
    const strategyId = strategy.id;
    const config = strategy.config;
    
    // STEP 1: Finalize the current leg's finances
    // We move any active profit/loss into the "Booked" bucket so it's permanently saved.
    leg.state = "COMPLETED";
    leg.exited = true;
    leg.exitType = exitType;
    leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0);
    leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0);
    leg.currentActivePnlPoints = 0;
    leg.currentActivePnlRupees = 0;

    // STEP 2: Create a snapshot for history
    // This allows the user to see exactly what happened in the past (Entry, Exit, and SL prices).
    leg.exitSnapshot = {
        slTriggerPrice: leg.slTriggerPrice,
        initialSlTriggerPrice: leg.initialSlTriggerPrice,
        exitLtp: leg.currentLtp,
        exitTime: getISTTime(),
        peakPrice: leg.peakPrice
    };
    leg.exitTime = getISTTime();

    // STEP 3: Clean up order IDs
    // We clear the SL order IDs because that order is now dead/executed.
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;
    leg.slLimitPrice = null;
    leg.slTriggerPrice = null;
    leg.exchangeSlProcessed = true;

    addStrategyLog(strategyId, `Leg stopped out: ${leg.instrument?.symbol || 'Unknown'}. Reason: ${exitType}. PnL: ₹${(leg.pnlRupees || 0).toFixed(2)}`, exitType.includes("ERROR") ? "ERROR" : "INFO");

    /** 
     * LOGIC: RE-ASAP (Re-Entry As Soon As Possible)
     * If the user wants to jump back into the trade immediately after being kicked out.
     */
    if (leg.leg.re_asap_enabled && (leg.reentry_count < (leg.leg.re_asap_max_entries || 1))) {
        addStrategyLog(strategyId, `RE ASAP triggered for ${leg.instrument?.symbol || "leg"}. Re-calculating entry for reentry #${leg.reentry_count + 1}`, "INFO");

        const newLeg = {
            leg: { ...leg.leg },
            instrument: null, // We reset this so the system picks the best strike again
            orderId: `VU-ASAP-${Date.now()}`,
            uniqueOrderId: `VU-ASAP-${Date.now()}`,
            state: "WAITING_FOR_RE_ASAP", // Special state that tells the engine to enter immediately
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: null,
            last_tick_price: null,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: 0,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
        return;
    }

    /** 
     * LOGIC: RE-COST (Re-Entry at Entry Price)
     * This waits for the market to come back to your original entry price before re-buying/selling.
     */
    if (leg.leg.recost_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const otp = leg.base_otp || leg.original_traded_price;
        const mode = leg.leg.recost_mode || "RECOST_PLUS_PCT";
        const val = leg.leg.recost_value || 0;
        let rtp = otp;

        if (mode === "RECOST_PLUS_PCT") rtp = otp + (otp * val / 100);
        else if (mode === "RECOST_PLUS_PTS") rtp = otp + val;
        else if (mode === "RECOST_MINUS_PCT") rtp = otp - (otp * val / 100);
        else if (mode === "RECOST_MINUS_PTS") rtp = otp - val;

        const newRtp = roundToTick(rtp);
        const currentLtp = leg.currentLtp || newRtp;
        const side = leg.leg.side;

        if (leg.leg.recost_mntm_enabled) {
            console.log(`[RE-COST MNTM] SL Hit for ${leg.instrument?.symbol}. Setting state to WAITING_FOR_MNTM. Target RTP=${newRtp}`);
            const mntmMode = leg.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
            const mntmVal = leg.leg.recost_mntm_value || 0;
            let mntmMtp = newRtp;
            if (mntmMode === "RECOST_PLUS_PCT") mntmMtp = newRtp + (newRtp * mntmVal / 100);
            else if (mntmMode === "RECOST_PLUS_PTS") mntmMtp = newRtp + mntmVal;
            else if (mntmMode === "RECOST_MINUS_PCT") mntmMtp = newRtp - (newRtp * mntmVal / 100);
            else if (mntmMode === "RECOST_MINUS_PTS") mntmMtp = newRtp - mntmVal;
            const finalMtp = roundToTick(mntmMtp);

            const newLeg = {
                leg: { ...leg.leg },
                instrument: { ...leg.instrument },
                orderId: null,
                uniqueOrderId: null,
                exitOrderId: null,
                state: "WAITING_FOR_MNTM",
                legIndex: leg.legIndex,
                exited: false,
                exitType: null,
                isExiting: false,
                entryPrice: null,
                currentLtp: currentLtp,
                last_tick_price: currentLtp,
                reentry_count: leg.reentry_count, 
                original_traded_price: 0,
                base_otp: otp,
                recost_trigger_price: newRtp,
                bookedPnlPoints: 0,
                bookedPnlRupees: 0,
                currentActivePnlPoints: 0,
                currentActivePnlRupees: 0,
                currentActivePnlPercent: 0,
                pnlPercent: 0,
                pnlPoints: 0,
                pnlRupees: 0,
                slOrderId: null,
                slUniqueOrderId: null,
                slTriggerPrice: null,
                slLimitPrice: null,
                rtp: newRtp,
                mtp: finalMtp,
                exchangeSlProcessed: false
            };
            strategy.legs.push(newLeg);
            return; 
        }

        let variety = config.variety || "NORMAL";
        let ordertype = config.ordertype || "LIMIT";
        const offsetAmt = getLimitOffsetAmt(newRtp, config);

        let finalPriceStr = newRtp.toString();
        let triggerPriceStr = newRtp.toString();

        if (side === "SELL") {
            if (newRtp < currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp - offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp - offsetAmt).toString();
            }
        } else if (side === "BUY") {
            if (newRtp > currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp + offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp + offsetAmt).toString();
            }
        }

        const newLeg = {
            leg: { ...leg.leg },
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            legIndex: leg.legIndex,
            state: "WAITING_FOR_FILL", // Temporarily wait for fill before ACTIVE
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: currentLtp,
            last_tick_price: currentLtp,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: otp,
            recost_trigger_price: newRtp,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            currentActivePnlPercent: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            rtp: newRtp,
            mtp: null,
            exchangeSlProcessed: false,
            tslReferencePrice: null
        };

        strategy.legs.push(newLeg);

        try {
            console.log(`[RE-COST] Firing Immediate Re-Cost Order for ${newLeg.instrument.symbol}. RTP=${newRtp}, LTP=${currentLtp}, Var/Type=${variety}/${ordertype}`);
            const reEntryOrder = await placeOrder(
                {
                    ...config,
                    side: side,
                    variety: variety,
                    ordertype: ordertype,
                    price: finalPriceStr,
                    triggerprice: triggerPriceStr,
                    lots: newLeg.leg.lots
                },
                newLeg.instrument,
                config.connectionId
            );

            newLeg.orderId = reEntryOrder.orderid;
            newLeg.uniqueOrderId = reEntryOrder.uniqueorderid;

            try {
                const fill = await waitForOrderFillPrice(
                    newLeg.uniqueOrderId,
                    config.connectionId,
                    config.is_paper_trading === true,
                    newLeg.instrument,
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
                if (fill) {
                    newLeg.entryPrice = fill;
                    newLeg.entryTime = getISTTime();
                    newLeg.original_traded_price = newLeg.entryPrice;
                    newLeg.tslReferencePrice = fill;
                    newLeg.state = "ACTIVE";
                }
            } catch (e) {
                console.error("[RE-COST] Fill monitoring failed:", e.message);
            }

            const isSlEnabled = newLeg.leg.reentry_sl_enabled ? true : newLeg.leg.sl_enabled !== false;
            if (config.variety === "STOPLOSS" && newLeg.entryPrice && isSlEnabled) {
                const activeSlType = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_type : (newLeg.leg.sl_type || "PERCENTAGE");
                const activeSlValue = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_value : newLeg.leg.stop_loss;

                const slOrder = await placeStopLossWithRetry({
                    baseConfig: config,
                    legSide: newLeg.leg.side,
                    entryPrice: newLeg.entryPrice,
                    instrument: newLeg.instrument,
                    lots: newLeg.leg.lots,
                    slType: activeSlType,
                    slValue: activeSlValue,
                    slLimitMargin: config.entry_limit_offset,
                    slLimitMarginType: config.entry_limit_offset_type || 'POINTS',
                    connectionId: config.connectionId,
                    strategyId: strategyId
                });
                if (slOrder?.orderid) {
                    const prices = computeStopLossExitPrices(newLeg.entryPrice, newLeg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset, config.entry_limit_offset_type || 'POINTS');
                    newLeg.slOrderId = slOrder.orderid;
                    newLeg.slUniqueOrderId = slOrder.uniqueorderid;
                    newLeg.slTriggerPrice = prices?.trigger;
                    newLeg.slLimitPrice = prices?.limit;
                    newLeg.exchangeSlProcessed = false;
                }
            }
        } catch (err) {
            console.error("[RE-COST] Immediate Re-entry failed. Halting leg completely.", err);
            newLeg.state = "COMPLETED";
            newLeg.exited = true;
        }
        return;
    }

    /** 
     * LOGIC: RE-SL (Re-Entry at Stop-Loss Price)
     * This waits for the market to come back to the price where you were just stopped out.
     * It's essentially "trying again" at the same price point.
     */
    if (leg.leg.resl_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const slPrice = leg.currentLtp || leg.exitSnapshot?.exitLtp; // Price where the SL hit
        const mode = leg.leg.resl_mode || "RESL_PLUS_PCT";
        const val = leg.leg.resl_value || 0;
        let rtp = slPrice;

        // RTP = Re-entry Trigger Price. 
        if (mode === "RESL_PLUS_PCT") rtp = slPrice + (slPrice * val / 100);
        else if (mode === "RESL_PLUS_PTS") rtp = slPrice + val;
        else if (mode === "RESL_MINUS_PCT") rtp = slPrice - (slPrice * val / 100);
        else if (mode === "RESL_MINUS_PTS") rtp = slPrice - val;

        const newRtp = roundToTick(rtp);
        const currentLtp = leg.currentLtp || newRtp;
        const side = leg.leg.side;

        if (leg.leg.resl_mntm_enabled) {
            console.log(`[RE-SL] SL Hit for ${leg.instrument?.symbol}. Setting state to WAITING_FOR_RESL_MNTM. Target Price=${newRtp}`);
            const mntmMode = leg.leg.resl_mntm_mode || "RESL_PLUS_PCT";
            const mntmVal = leg.leg.resl_mntm_value || 0;
            let mntmMtp = newRtp;
            
            // MTP = Momentum Target Price.
            if (mntmMode === "RESL_PLUS_PCT") mntmMtp = newRtp + (newRtp * mntmVal / 100);
            else if (mntmMode === "RESL_PLUS_PTS") mntmMtp = newRtp + mntmVal;
            else if (mntmMode === "RESL_MINUS_PCT") mntmMtp = newRtp - (newRtp * mntmVal / 100);
            else if (mntmMode === "RESL_MINUS_PTS") mntmMtp = newRtp - mntmVal;
            const finalMtp = roundToTick(mntmMtp);

            const newLeg = {
                leg: { ...leg.leg },
                instrument: { ...leg.instrument },
                orderId: null,
                uniqueOrderId: null,
                exitOrderId: null,
                state: "WAITING_FOR_RESL_MNTM", // State: Waiting for SL price to be hit again
                legIndex: leg.legIndex,
                exited: false,
                exitType: null,
                isExiting: false,
                entryPrice: null,
                currentLtp: currentLtp,
                last_tick_price: currentLtp,
                reentry_count: leg.reentry_count, 
                original_traded_price: 0,
                base_otp: leg.base_otp || leg.original_traded_price,
                resl_trigger_price: newRtp,
                bookedPnlPoints: 0,
                bookedPnlRupees: 0,
                currentActivePnlPoints: 0,
                currentActivePnlRupees: 0,
                currentActivePnlPercent: 0,
                pnlPercent: 0,
                pnlPoints: 0,
                pnlRupees: 0,
                slOrderId: null,
                slUniqueOrderId: null,
                slTriggerPrice: null,
                slLimitPrice: null,
                rtp: newRtp,
                mtp: finalMtp,
                exchangeSlProcessed: false
            };
            strategy.legs.push(newLeg);
            return; 
        }

        let variety = config.variety || "NORMAL";
        let ordertype = config.ordertype || "LIMIT";
        const offsetAmt = getLimitOffsetAmt(newRtp, config);

        let finalPriceStr = newRtp.toString();
        let triggerPriceStr = newRtp.toString();

        if (side === "SELL") {
            if (newRtp < currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp - offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp - offsetAmt).toString();
            }
        } else if (side === "BUY") {
            if (newRtp > currentLtp) {
                variety = "STOPLOSS";
                ordertype = "STOPLOSS_LIMIT";
                finalPriceStr = roundToTick(newRtp + offsetAmt).toString();
            } else {
                variety = "NORMAL";
                ordertype = "LIMIT";
                finalPriceStr = roundToTick(newRtp + offsetAmt).toString();
            }
        }

        const newLeg = {
            leg: { ...leg.leg },
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            legIndex: leg.legIndex,
            state: "WAITING_FOR_FILL",
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: currentLtp,
            last_tick_price: currentLtp,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: leg.base_otp || leg.original_traded_price,
            resl_trigger_price: newRtp,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            currentActivePnlPercent: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            rtp: newRtp,
            mtp: null,
            exchangeSlProcessed: false,
            tslReferencePrice: null
        };

        strategy.legs.push(newLeg);

        try {
            console.log(`[RE-SL] Firing Immediate Re-Entry Order for ${newLeg.instrument.symbol}. RTP=${newRtp}, LTP=${currentLtp}, Var/Type=${variety}/${ordertype}`);
            const reEntryOrder = await placeOrder(
                {
                    ...config,
                    side: side,
                    variety: variety,
                    ordertype: ordertype,
                    price: finalPriceStr,
                    triggerprice: triggerPriceStr,
                    lots: newLeg.leg.lots
                },
                newLeg.instrument,
                config.connectionId
            );

            newLeg.orderId = reEntryOrder.orderid;
            newLeg.uniqueOrderId = reEntryOrder.uniqueorderid;

            try {
                const fill = await waitForOrderFillPrice(
                    newLeg.uniqueOrderId,
                    config.connectionId,
                    config.is_paper_trading === true,
                    newLeg.instrument,
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
                if (fill) {
                    newLeg.entryPrice = fill;
                    newLeg.entryTime = getISTTime();
                    newLeg.original_traded_price = newLeg.entryPrice;
                    newLeg.tslReferencePrice = fill;
                    newLeg.state = "ACTIVE";
                }
            } catch (e) {
                console.error("[RE-SL] Fill monitoring failed:", e.message);
            }

            const isSlEnabled = newLeg.leg.reentry_sl_enabled ? true : newLeg.leg.sl_enabled !== false;
            if (config.variety === "STOPLOSS" && newLeg.entryPrice && isSlEnabled) {
                const activeSlType = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_type : (newLeg.leg.sl_type || "PERCENTAGE");
                const activeSlValue = newLeg.leg.reentry_sl_enabled ? newLeg.leg.reentry_sl_value : newLeg.leg.stop_loss;

                const slOrder = await placeStopLossWithRetry({
                    baseConfig: config,
                    legSide: newLeg.leg.side,
                    entryPrice: newLeg.entryPrice,
                    instrument: newLeg.instrument,
                    lots: newLeg.leg.lots,
                    slType: activeSlType,
                    slValue: activeSlValue,
                    slLimitMargin: config.entry_limit_offset,
                    slLimitMarginType: config.entry_limit_offset_type || 'POINTS',
                    connectionId: config.connectionId,
                    strategyId: strategyId
                });
                if (slOrder?.orderid) {
                    const prices = computeStopLossExitPrices(newLeg.entryPrice, newLeg.leg.side, activeSlType, activeSlValue, config.entry_limit_offset, config.entry_limit_offset_type || 'POINTS');
                    newLeg.slOrderId = slOrder.orderid;
                    newLeg.slUniqueOrderId = slOrder.uniqueorderid;
                    newLeg.slTriggerPrice = prices?.trigger;
                    newLeg.slLimitPrice = prices?.limit;
                    newLeg.exchangeSlProcessed = false;
                }
            }
        } catch (err) {
            console.error("[RE-SL] Immediate Re-entry failed. Halting leg completely.", err);
            newLeg.state = "COMPLETED";
            newLeg.exited = true;
        }
        return;
    }


    /** 
     * LOGIC: RE-HIGH (Re-Entry at New High)
     * This waits for the market to make a new "Highest Price" after the SL hit,
     * and re-enters when the price drops back from that high by a certain amount.
     */
    if (leg.leg.rehigh_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const peakPrice = leg.currentLtp || leg.original_traded_price;
        const currentLtp = leg.currentLtp || peakPrice;
        
        let triggerPrice = peakPrice;
        const mode = leg.leg.rehigh_mode || 'REHIGH_MINUS_PTS';
        const val = leg.leg.rehigh_value || 0;
        // We calculate the initial trigger price based on the high reached at the moment of SL hit.
        if (mode === 'REHIGH_MINUS_PCT') triggerPrice = peakPrice - (peakPrice * val / 100);
        else if (mode === 'REHIGH_MINUS_PTS') triggerPrice = peakPrice - val;

        addStrategyLog(strategyId, `[RE-HIGH] SL Hit for ${leg.instrument?.symbol}. PEAK: ₹${peakPrice} | RTP: ₹${triggerPrice} | MTP: ${leg.leg.rehigh_mntm_enabled ? 'Calculating...' : 'N/A'}`, "INFO");
        const newLeg = {
            leg: { ...leg.leg },
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            state: "WAITING_FOR_RE_HIGH", // State: Tracking for higher peaks and entry bounce
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: currentLtp,
            last_tick_price: currentLtp,
            reentry_count: leg.reentry_count, 
            original_traded_price: 0,
            base_otp: leg.base_otp || leg.original_traded_price,
            re_high_trigger_price: triggerPrice,
            max_peak_price: peakPrice,
            final_peak_reached: leg.final_peak_reached || 0, // Carry over if exists
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            currentActivePnlPercent: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            rtp: triggerPrice,
            mtp: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
        return; 
    }

    /** 
     * LOGIC: RE-LOW (Re-Entry at New Low)
     * The opposite of RE-HIGH. This waits for the market to make a new "Lowest Price" after the SL hit,
     * and re-enters when the price bounces back up from that low.
     */
    if (leg.leg.relow_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        const currentLtp = leg.currentLtp || leg.original_traded_price;
        const lowPrice = currentLtp; 
        
        let triggerPrice = lowPrice;
        const mode = leg.leg.relow_mode || 'RELOW_PLUS_PTS';
        const val = leg.leg.relow_value || 0;

        if (mode === 'RELOW_PLUS_PCT') triggerPrice = lowPrice + (lowPrice * val / 100);
        else if (mode === 'RELOW_PLUS_PTS') triggerPrice = lowPrice + val;
        else if (mode === 'RELOW_MINUS_PCT') triggerPrice = lowPrice - (lowPrice * val / 100);
        else if (mode === 'RELOW_MINUS_PTS') triggerPrice = lowPrice - val;

        addStrategyLog(strategyId, `[RE-LOW] SL Hit for ${leg.instrument?.symbol}. LOW: ₹${lowPrice} | RTP: ₹${triggerPrice} | MTP: ${leg.leg.relow_mntm_enabled ? 'Calculating...' : 'N/A'}`, "INFO");
        const newLeg = {
            leg: { ...leg.leg },
            instrument: { ...leg.instrument },
            orderId: null,
            uniqueOrderId: null,
            exitOrderId: null,
            state: "WAITING_FOR_RE_LOW", // State: Tracking for lower lows and entry bounce
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: currentLtp,
            last_tick_price: currentLtp,
            reentry_count: leg.reentry_count, 
            original_traded_price: 0,
            base_otp: leg.base_otp || leg.original_traded_price,
            re_low_trigger_price: triggerPrice,
            max_low_price: lowPrice,
            final_low_reached: leg.final_low_reached || 0, // Carry over if exists
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            currentActivePnlPercent: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            rtp: triggerPrice,
            mtp: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
        return; 
    }
    if (leg.leg.lazy_leg_enabled && leg.leg.lazy_leg) {
        addStrategyLog(strategyId, `Lazy Leg triggered after ${leg.instrument?.symbol || "leg"} stop-out. Initializing lazy leg...`, "INFO");

        const newLeg = {
            leg: { ...leg.leg.lazy_leg }, 
            instrument: null,
            orderId: null,
            uniqueOrderId: null,
            state: "WAITING_FOR_LAZY",
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: null,
            last_tick_price: null,
            reentry_count: 0,
            original_traded_price: 0,
            base_otp: 0,
            bookedPnlPoints: 0,
            bookedPnlRupees: 0,
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            pnlPercent: 0,
            pnlPoints: 0,
            pnlRupees: 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
    } else {
        console.log(`[RE-COST/LAZY] Leg ${leg.instrument?.symbol} fully stopped out and completed.`);
    }
}

function pauseStrategy(strategyId, reason) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    strategy.status = "PAUSED";
    strategy.error = reason;
    if (strategy.interval) {
        clearInterval(strategy.interval);
        strategy.interval = null;
    }

    addStrategyLog(strategyId, `Strategy PAUSED: ${reason}. Manual intervention required.`, "CRITICAL");
    updateStrategyInMemory(strategyId, { 
        status: "PAUSED", 
        error: reason,
        pnlPercent: strategy.pnlPercent || 0,
        totalPnlRupees: strategy.totalPnlRupees || 0,
        totalOriginalValue: strategy.totalOriginalValue || 0,
        legs: strategy.legs,
        _pausedAt: new Date().toISOString()
    });

    const marketSocketService = require("../marketSocket.service");
    marketSocketService.sendAlert(`Strategy PAUSED — ${reason}`, "error");
}

function stopStrategy(strategyId, reason) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    strategy.status = "COMPLETED";
    strategy.error = reason;
    if (strategy.interval) {
        clearInterval(strategy.interval);
        strategy.interval = null;
    }

    addStrategyLog(strategyId, `Strategy CLOSED: ${reason}.`, "CRITICAL");
    updateStrategyInMemory(strategyId, { 
        status: "COMPLETED", 
        error: reason,
        pnlPercent: strategy.pnlPercent || 0,
        totalPnlRupees: strategy.totalPnlRupees || 0,
        legs: strategy.legs,
        _closedAt: new Date().toISOString()
    });

    const marketSocketService = require("../marketSocket.service");
    marketSocketService.sendAlert(`Strategy CLOSED — ${reason}`, "error");
}

async function squareOffStrategy(strategyId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
    const { getAuthorizedInstance } = require("../../config/smartapi");
    const { placeExitOrder } = require("./strategy.execution");
    const { pauseStrategy } = require("./strategy.lifecycle");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    
    // FIX: Allow square off from WAITING status (abort before entry).
    // Previously only IN_POSITION was allowed, which meant users couldn't abort
    // a strategy that was waiting for entry time or had failed to enter.
    if (!["IN_POSITION", "WAITING"].includes(strategy.status)) {
        throw new Error(`Strategy must be in IN_POSITION or WAITING to be squared off. Current: ${strategy.status}`);
    }

    if (strategy.exitAttempted) throw new Error('Exit already in progress');
    strategy.exitAttempted = true;
    
    // CASE A: Strategy is still WAITING (no positions yet)
    if (strategy.status === "WAITING") {
        addStrategyLog(strategyId, "MANUAL ABORT triggered. Strategy was WAITING — no positions to close.", "INFO");
        strategy.status = "COMPLETED";
        if (strategy.interval) clearInterval(strategy.interval);
        updateStrategyInMemory(strategyId, {
            status: "COMPLETED", 
            exit_type: "MANUAL_ABORT",
            legs: strategy.legs
        });
        activeStrategies.delete(strategyId);
        return true;
    }

    // CASE B: Strategy is IN_POSITION
    addStrategyLog(strategyId, "MANUAL SQUARE OFF triggered. Closing all positions...", "CRITICAL");

    const { config } = strategy;

    if (!config.is_paper_trading) {
        await Promise.all(strategy.legs.map(async (leg) => {
            if (!leg.exited && leg.slOrderId) {
                try {
                    const api = await getAuthorizedInstance(config.connectionId);
                    await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                } catch (e) {}
            }
        }));
    }

    try {
        const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
            if (leg.exited) return leg.exitOrderId;
            return await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: "MANUAL_SQUARE_OFF" });
        }));

        strategy.status = "COMPLETED";
        updateStrategyInMemory(strategyId, {
            status: "COMPLETED", 
            exit_type: "MANUAL_SQUARE_OFF", 
            final_pnl_percent: strategy.pnlPercent || 0,
            totalPnlRupees: strategy.totalPnlRupees || 0,
            totalOriginalValue: strategy.totalOriginalValue || 0,
            legs: strategy.legs
        });

        if (strategy.interval) clearInterval(strategy.interval);
    } catch (exitErr) {
        if (exitErr.message?.startsWith("EXIT_CHASE_EXHAUSTED")) {
            strategy.exitAttempted = false; // Allow re-attempt if user resumes
            pauseStrategy(strategyId, `Manual Square Off chase failed: ${exitErr.message}`);
        } else throw exitErr;
    }
    return true;
}

async function squareOffLeg(strategyId, legIndex) {
    const { activeStrategies, addStrategyLog } = require("./strategy.state");
    const { placeExitOrder } = require("./strategy.execution");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    const leg = strategy.legs[legIndex];
    if (!leg) throw new Error("Leg not found");
    if (leg.exited) return true;

    addStrategyLog(strategyId, `Manual Square Off for leg ${leg.instrument?.symbol || legIndex}`, "INFO");
    await placeExitOrder({ config: strategy.config, leg, instrument: leg.instrument, exitType: "MANUAL_LEG_SQUARE_OFF" });
    leg.exited = true;
    leg.exitType = "MANUAL_LEG_SQUARE_OFF";
    return true;
}

async function resumeStrategy(strategyId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
    const { executeStrategy } = require("./strategy.engine");
    const marketSocketService = require("../marketSocket.service");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy is not active or not found");
    if (strategy.status !== "PAUSED") throw new Error("Strategy is not in PAUSED state");

    // Reset markers
    strategy.error = null;
    strategy.exitAttempted = false;

    if (!strategy.legs || strategy.legs.length === 0) {
        // Paused during initial entry
        strategy.status = "WAITING";
        strategy.entryAttempted = false;
        addStrategyLog(strategyId, `Strategy RESUMED. Resetting entry attempt to retry...`, "INFO");
    } else {
        // Paused while in position
        strategy.status = "IN_POSITION";
        addStrategyLog(strategyId, `Strategy RESUMED from PAUSED state. Monitoring restarted.`, "INFO");
    }

    marketSocketService.sendAlert(`Strategy resumed — monitoring active`, "success");
    updateStrategyInMemory(strategyId, { 
        status: strategy.status, 
        error: null, 
        entryAttempted: strategy.entryAttempted 
    });

    // Re-start the engine interval
    executeStrategy(strategyId);

    return true;
}

module.exports = {
    handleLegStopOut,
    pauseStrategy,
    stopStrategy,
    squareOffStrategy,
    squareOffLeg,
    resumeStrategy
};
