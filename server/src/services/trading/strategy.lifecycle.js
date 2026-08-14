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

const { getISTTime, getISTExchangeFormat } = require("./strategy.time");
const { addStrategyLog, activeStrategies, updateStrategyInMemory } = require("./strategy.state");
const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry, cancelOrder } = require("./strategy.execution");

/**
 * Handles the complete "Exit" process of a single leg.
 * @param {Object} leg - The current trade leg being closed.
 * @param {String} exitType - Why the trade closed (e.g., 'STOPLOSS', 'SQUARE_OFF').
 * @param {Object} strategy - The parent strategy object.
 */
async function handleLegStopOut(leg, exitType, strategy, exchangeFillData = null) {
    const strategyId = strategy.id;
    const config = strategy.config;

    // STEP 1: If we have actual exchange fill data, use it for accurate PnL
    // The exchange fill price accounts for real slippage, unlike the WebSocket LTP.
    if (exchangeFillData?.exchangeFillPrice) {
        leg.currentLtp = exchangeFillData.exchangeFillPrice;
    }

    if (leg.entryPrice && leg.currentLtp) {
        const pnlPoints = leg.leg.side === "BUY"
            ? (leg.currentLtp - leg.entryPrice)
            : (leg.entryPrice - leg.currentLtp);
        const multiplier = parseFloat(config.quantity_multiplier) || 1;
        const quantity = leg.leg.lots * parseInt(leg.instrument?.lotsize || 1) * multiplier;
        leg.currentActivePnlPoints = pnlPoints;
        leg.currentActivePnlRupees = pnlPoints * quantity;
    }

    // STEP 2: Finalize the current leg's finances
    // We move any active profit/loss into the "Booked" bucket so it's permanently saved.
    leg.state = "COMPLETED";
    leg.exited = true;
    leg.exitType = exitType;
    leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0);
    leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0);
    leg.currentActivePnlPoints = 0;
    leg.currentActivePnlRupees = 0;

    // FIX: Update the display PnL properties to reflect the final booked amounts
    leg.pnlPoints = leg.bookedPnlPoints;
    leg.pnlRupees = leg.bookedPnlRupees;
    if (leg.original_traded_price) {
        leg.pnlPercent = (leg.pnlPoints / leg.original_traded_price) * 100;
    }

    // STEP 3: Create a snapshot for history
    // This allows the user to see exactly what happened in the past (Entry, Exit, and SL prices).
    let exitTime = exchangeFillData?.exchangeFillTime || getISTExchangeFormat();
    
    // We still need the HH:mm format for slHitMinute (used for SL re-entry block)
    const slHitMinute = getISTTime().substring(0, 5);

    const finalExitLtp = exchangeFillData?.exchangeFillPrice || leg.currentLtp;
    leg.exitSnapshot = {
        slTriggerPrice: leg.slTriggerPrice,
        initialSlTriggerPrice: leg.initialSlTriggerPrice,
        exitLtp: finalExitLtp,
        exitTime: exitTime,
        peakPrice: leg.peakPrice
    };
    leg.exitTime = exitTime;
    if (finalExitLtp) {
        leg.currentLtp = finalExitLtp;
    }

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
            slHitMinute: slHitMinute,
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
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

        console.log(`[RE-COST] SL Hit for ${leg.instrument?.symbol}. Setting state to WAITING_FOR_MNTM. Target RTP=${newRtp}`);
        const mntmMode = leg.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
        const mntmVal = leg.leg.recost_mntm_value || 0;
        let mntmMtp = newRtp;

        if (leg.leg.recost_mntm_enabled) {
            if (mntmMode === "RECOST_PLUS_PCT") mntmMtp = newRtp + (newRtp * mntmVal / 100);
            else if (mntmMode === "RECOST_PLUS_PTS") mntmMtp = newRtp + mntmVal;
            else if (mntmMode === "RECOST_MINUS_PCT") mntmMtp = newRtp - (newRtp * mntmVal / 100);
            else if (mntmMode === "RECOST_MINUS_PTS") mntmMtp = newRtp - mntmVal;
        }
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
            mtp: leg.leg.recost_mntm_enabled ? finalMtp : null,
            slHitMinute: slHitMinute,
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
        };
        strategy.legs.push(newLeg);
        return;
    }

    /** 
     * LOGIC: RE-SL (Re-Entry at Stop-Loss Price)
     * This waits for the market to come back to the price where you were just stopped out.
     * It's essentially "trying again" at the same price point.
     */
    if (leg.leg.resl_enabled && (leg.reentry_count < (leg.leg.max_reentry || 1))) {
        let newRtp;
        let finalMtp = null;
        let slPrice;
        
        if (leg.base_resl_rtp != null) {
            // Carry over the initial RTP & MTP for all subsequent re-entries
            newRtp = leg.base_resl_rtp;
            finalMtp = leg.base_resl_mtp;
            slPrice = leg.base_resl_sl_hit;
        } else {
            slPrice = leg.currentLtp || leg.exitSnapshot?.exitLtp; // Price where the FIRST SL hit
            const mode = leg.leg.resl_mode || "RESL_PLUS_PCT";
            const val = leg.leg.resl_value || 0;
            let rtp = slPrice;

            // RTP = Re-entry Trigger Price. 
            if (mode === "RESL_PLUS_PCT") rtp = slPrice + (slPrice * val / 100);
            else if (mode === "RESL_PLUS_PTS") rtp = slPrice + val;
            else if (mode === "RESL_MINUS_PCT") rtp = slPrice - (slPrice * val / 100);
            else if (mode === "RESL_MINUS_PTS") rtp = slPrice - val;

            newRtp = roundToTick(rtp);

            const mntmMode = leg.leg.resl_mntm_mode || "RESL_PLUS_PCT";
            const mntmVal = leg.leg.resl_mntm_value || 0;
            let mntmMtp = newRtp;
            
            if (leg.leg.resl_mntm_enabled) {
                // MTP = Momentum Target Price.
                if (mntmMode === "RESL_PLUS_PCT") mntmMtp = newRtp + (newRtp * mntmVal / 100);
                else if (mntmMode === "RESL_PLUS_PTS") mntmMtp = newRtp + mntmVal;
                else if (mntmMode === "RESL_MINUS_PCT") mntmMtp = newRtp - (newRtp * mntmVal / 100);
                else if (mntmMode === "RESL_MINUS_PTS") mntmMtp = newRtp - mntmVal;
                finalMtp = roundToTick(mntmMtp);
            }
        }

        const currentLtp = leg.currentLtp || newRtp;
        const side = leg.leg.side;

        console.log(`[RE-SL] SL Hit for ${leg.instrument?.symbol}. Setting state to WAITING_FOR_RESL_MNTM. Target Price=${newRtp}`);

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
            base_otp: leg.base_otp || leg.original_traded_price, slHitMinute: slHitMinute,
            base_resl_rtp: newRtp,
            base_resl_mtp: finalMtp,
            base_resl_sl_hit: slPrice,
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
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
        };
        strategy.legs.push(newLeg);
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
            base_otp: leg.base_otp || leg.original_traded_price, slHitMinute: slHitMinute,
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
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
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
            base_otp: leg.base_otp || leg.original_traded_price, slHitMinute: slHitMinute,
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
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
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
            slHitMinute: slHitMinute,
            exchangeSlProcessed: false,
            is_virtual_leg: config.is_virtual === true
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
    marketSocketService.sendAlertToUser(strategy.user_id, `Strategy PAUSED — ${reason}`, "error");
}

function stopStrategy(strategyId, reason) {
    const strategy = activeStrategies.get(strategyId);
    if (!strategy) return;

    strategy.status = "EXITED";
    strategy.error = reason;
    if (strategy.interval) {
        clearInterval(strategy.interval);
        strategy.interval = null;
    }

    addStrategyLog(strategyId, `Strategy CLOSED: ${reason}.`, "CRITICAL");
    updateStrategyInMemory(strategyId, {
        status: "EXITED",
        error: reason,
        final_pnl_percent: strategy.pnlPercent || 0,
        pnlPercent: strategy.pnlPercent || 0,
        totalPnlRupees: strategy.totalPnlRupees || 0,
        totalOriginalValue: strategy.totalOriginalValue || 0,
        legs: strategy.legs,
        _closedAt: new Date().toISOString()
    });

    const marketSocketService = require("../marketSocket.service");
    marketSocketService.sendAlertToUser(strategy.user_id, `Strategy CLOSED — ${reason}`, "error");
}

async function squareOffStrategy(strategyId, userId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
    const { getAuthorizedInstance } = require("../../config/smartapi");
    const { placeExitOrder } = require("./strategy.execution");
    const { pauseStrategy } = require("./strategy.lifecycle");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (userId && strategy.user_id !== userId) throw new Error("Unauthorized access to this strategy");

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

    const isVirtual = config.is_virtual === true || strategy.is_virtual === true;

    if (!config.is_paper_trading && !isVirtual) {
        await Promise.all(strategy.legs.map(async (leg) => {
            if (!leg.exited && leg.slOrderId && !leg.is_virtual_monitoring && !leg.is_virtual_leg) {
                try {
                    await cancelOrder(config, "STOPLOSS", leg.slOrderId);
                } catch (e) { }
            }
        }));
    }

    try {
        const exitResults = await Promise.allSettled(strategy.legs.map(async (leg) => {
            if (leg.exited) return leg.exitOrderId;
            return await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: "MANUAL_SQUARE_OFF" });
        }));

        const chaseErrors = exitResults.filter(r => r.status === 'rejected' && r.reason?.message?.startsWith("EXIT_CHASE_EXHAUSTED"));
        if (chaseErrors.length > 0) {
            strategy.exitAttempted = false; // Allow re-attempt if user resumes
            pauseStrategy(strategyId, `Manual Square Off chase failed: ${chaseErrors[0].reason.message}`);
        } else {
            const otherErrors = exitResults.filter(r => r.status === 'rejected');
            if (otherErrors.length > 0) {
                strategy.exitAttempted = false;
                pauseStrategy(strategyId, `Manual Square Off failed: ${otherErrors[0].reason.message}`);
                return true;
            }

            const exitOrders = exitResults.map(r => r.value);

            strategy.status = "EXITED";
            updateStrategyInMemory(strategyId, {
                status: "EXITED",
                exit_type: "MANUAL_SQUARE_OFF",
                final_pnl_percent: strategy.pnlPercent || 0,
                totalPnlRupees: strategy.totalPnlRupees || 0,
                totalOriginalValue: strategy.totalOriginalValue || 0,
                legs: strategy.legs
            });

            if (strategy.interval) clearInterval(strategy.interval);
        }
    } catch (exitErr) {
        throw exitErr;
    }
    return true;
}

async function squareOffLeg(strategyId, legIndex, userId) {
    const { activeStrategies, addStrategyLog } = require("./strategy.state");
    const { placeExitOrder } = require("./strategy.execution");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (userId && strategy.user_id !== userId) throw new Error("Unauthorized access to this strategy");
    const leg = strategy.legs[legIndex];
    if (!leg) throw new Error("Leg not found");
    if (leg.exited) return true;

    addStrategyLog(strategyId, `Manual Square Off for leg ${leg.instrument?.symbol || legIndex}`, "INFO");
    await placeExitOrder({ config: strategy.config, leg, instrument: leg.instrument, exitType: "MANUAL_LEG_SQUARE_OFF" });
    leg.exited = true;
    leg.exitType = "MANUAL_LEG_SQUARE_OFF";
    return true;
}

async function resumeStrategy(strategyId, userId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
    const { executeStrategy } = require("./strategy.engine");
    const marketSocketService = require("../marketSocket.service");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy is not active or not found");
    if (userId && strategy.user_id !== userId) throw new Error("Unauthorized access to this strategy");
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

    marketSocketService.sendAlertToUser(strategy.user_id, `Strategy resumed — monitoring active`, "success");
    updateStrategyInMemory(strategyId, {
        status: strategy.status,
        error: null,
        entryAttempted: strategy.entryAttempted
    });

    // Re-start the engine interval
    executeStrategy(strategyId);

    return true;
}

async function switchVirtualMode(strategyId, targetVirtual, userId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory, getLtpWithRetry } = require("./strategy.state");
    const { placeExitOrder, placeOrder, chaseOrderFill, placeStopLossWithRetry, cancelOrder } = require("./strategy.execution");
    const { roundToTick, getLimitOffsetAmt } = require("./strategy.offset");
    const marketSocketService = require("../marketSocket.service");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found or inactive");
    if (userId && strategy.user_id !== userId) throw new Error("Unauthorized access to this strategy");
    if (!["IN_POSITION", "WAITING"].includes(strategy.status)) {
        throw new Error(`Strategy must be IN_POSITION or WAITING to switch virtual mode. Current status: ${strategy.status}`);
    }

    const { config } = strategy;
    const isCurrentlyVirtual = strategy.is_virtual === true;

    if (targetVirtual === isCurrentlyVirtual) {
        return true; // Already in target mode
    }

    const exitTime = getISTExchangeFormat();

    if (targetVirtual) {
        // --- SWITCHING TO VIRTUAL MODE ---
        addStrategyLog(strategyId, `Switching strategy to VIRTUAL mode. Closing open positions...`, "INFO");

        const currentLegs = [...(strategy.legs || [])];
        const virtualLegsToPush = [];

        for (const leg of currentLegs) {
            if (!leg.exited && leg.entryPrice) {
                // 1. If strategy is Live, cancel exchange SL order and execute broker exit order
                if (!config.is_paper_trading) {
                    if (leg.slOrderId) {
                        try {
                            await cancelOrder(config, "STOPLOSS", leg.slOrderId);
                            leg.slOrderId = null;
                        } catch (e) {
                            console.warn(`[SwitchVirtual] Failed to cancel SL order ${leg.slOrderId}: ${e.message}`);
                        }
                    }
                    try {
                        await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: "SWITCHED_TO_VIRTUAL" });
                    } catch (e) {
                        console.error(`[SwitchVirtual] Error exiting live leg ${leg.instrument?.symbol}: ${e.message}`);
                    }
                }

                // 2. Book PnL for the current active leg up to currentLtp
                const exitLtp = leg.currentLtp || leg.entryPrice;
                const pnlPoints = leg.leg.side === "BUY" ? (exitLtp - leg.entryPrice) : (leg.entryPrice - exitLtp);
                const multiplier = parseFloat(config.quantity_multiplier) || 1;
                const quantity = leg.leg.lots * parseInt(leg.instrument?.lotsize || 1) * multiplier;
                const activePnlRupees = pnlPoints * quantity;

                leg.state = "COMPLETED";
                leg.exited = true;
                leg.exitType = "SWITCHED_TO_VIRTUAL";
                leg.exitTime = exitTime;
                leg.exitSnapshot = {
                    slTriggerPrice: leg.slTriggerPrice,
                    initialSlTriggerPrice: leg.initialSlTriggerPrice,
                    exitLtp: exitLtp,
                    exitTime: exitTime,
                    peakPrice: leg.peakPrice || leg.max_peak_price
                };
                leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + pnlPoints;
                leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + activePnlRupees;
                leg.currentActivePnlPoints = 0;
                leg.currentActivePnlRupees = 0;
                leg.pnlPoints = leg.bookedPnlRupees;
                leg.pnlRupees = leg.bookedPnlRupees;
                if (leg.original_traded_price) {
                    leg.pnlPercent = (leg.pnlPoints / leg.original_traded_price) * 100;
                }

                // 3. Create a NEW Virtual Monitoring Leg to continue background monitoring
                const virtualLeg = {
                    leg: { ...leg.leg },
                    instrument: leg.instrument ? { ...leg.instrument } : null,
                    orderId: `VIRTUAL-${Date.now()}`,
                    uniqueOrderId: `VIRTUAL-${Date.now()}`,
                    state: "VIRTUAL_MONITORING",
                    is_virtual_monitoring: true,
                    is_virtual_leg: true,
                    legIndex: leg.legIndex,
                    exited: false,
                    exitType: null,
                    isExiting: false,
                    entryTime: leg.entryTime || exitTime,
                    entryPrice: leg.entryPrice, // Continuous entry price for "what-if" PnL
                    currentLtp: exitLtp,
                    last_tick_price: exitLtp,
                    initialSlTriggerPrice: leg.initialSlTriggerPrice,
                    slTriggerPrice: leg.slTriggerPrice,
                    slLimitPrice: leg.slLimitPrice,
                    tslReferencePrice: leg.tslReferencePrice,
                    peakPrice: leg.peakPrice,
                    rtp: leg.rtp,
                    mtp: leg.mtp,
                    max_peak_price: leg.max_peak_price,
                    max_low_price: leg.max_low_price,
                    re_high_trigger_price: leg.re_high_trigger_price,
                    re_low_trigger_price: leg.re_low_trigger_price,
                    candleMinute: leg.candleMinute,
                    candleHigh: leg.candleHigh,
                    candleLow: leg.candleLow,
                    reentry_count: leg.reentry_count || 0,
                    original_traded_price: leg.original_traded_price || leg.entryPrice,
                    base_otp: leg.base_otp || leg.entryPrice,
                    bookedPnlPoints: 0,
                    bookedPnlRupees: 0,
                    currentActivePnlPoints: 0,
                    currentActivePnlRupees: 0,
                    pnlPercent: 0,
                    pnlPoints: 0,
                    pnlRupees: 0
                };

                virtualLegsToPush.push(virtualLeg);
            }
        }

        strategy.legs = [...currentLegs, ...virtualLegsToPush];
        strategy.is_virtual = true;
        // Set config AFTER broker exits have already been placed
        strategy.config.is_virtual = true;

        updateStrategyInMemory(strategyId, {
            is_virtual: true,
            legs: strategy.legs
        });

        addStrategyLog(strategyId, `Strategy switched to VIRTUAL mode. Open positions closed and moved to Closed Legs. Virtual monitoring legs spawned.`, "INFO");
        marketSocketService.sendAlertToUser(strategy.user_id, `Strategy switched to VIRTUAL mode — active positions closed, virtual monitoring running`, "info");
        return true;
    } else {
        // --- SWITCHING BACK FROM VIRTUAL MODE ---
        // Clear the virtual flag immediately so real broker orders are placed below
        strategy.config.is_virtual = false;
        addStrategyLog(strategyId, `Switching strategy back from VIRTUAL mode. Re-entering active legs...`, "INFO");

        const currentLegs = [...(strategy.legs || [])];
        const newActiveLegsToPush = [];

        for (const leg of currentLegs) {
            if (!leg.exited && leg.entryPrice) {
                const instrument = leg.instrument;
                if (!instrument) continue;

                // 1. Fetch fresh market LTP at the moment of switching back
                const currentLtp = await getLtpWithRetry({
                    exchange: instrument.exch_seg,
                    symboltoken: instrument.token,
                    connectionId: config.connectionId,
                    currentLtp: leg.currentLtp || 0
                });

                const reEntryPrice = (currentLtp && currentLtp > 0) ? currentLtp : (leg.currentLtp || leg.entryPrice);

                // 2. Mark the virtual monitoring leg as EXITED with the fresh market price
                leg.exited = true;
                leg.state = "COMPLETED";
                leg.exitType = config.is_paper_trading ? "SWITCHED_TO_PAPER" : "SWITCHED_TO_LIVE";
                leg.exitTime = exitTime;
                leg.currentLtp = reEntryPrice;

                if (leg.entryPrice) {
                    const pnlPts = leg.leg.side === "BUY" ? (reEntryPrice - leg.entryPrice) : (leg.entryPrice - reEntryPrice);
                    const multiplier = parseFloat(config.quantity_multiplier) || 1;
                    const qty = leg.leg.lots * parseInt(leg.instrument?.lotsize || 1) * multiplier;
                    leg.bookedPnlPoints = pnlPts;
                    leg.bookedPnlRupees = pnlPts * qty;
                    leg.pnlPoints = pnlPts;
                    leg.pnlRupees = leg.bookedPnlRupees;
                    if (leg.original_traded_price) {
                        leg.pnlPercent = (pnlPts / leg.original_traded_price) * 100;
                    }
                }

                leg.exitSnapshot = {
                    slTriggerPrice: leg.slTriggerPrice,
                    initialSlTriggerPrice: leg.initialSlTriggerPrice,
                    exitLtp: reEntryPrice,
                    exitTime: exitTime,
                    peakPrice: leg.peakPrice || leg.max_peak_price
                };
                const existingSlTrigger = leg.slTriggerPrice || leg.initialSlTriggerPrice;
                let liveOrderId = null;
                let liveUniqueOrderId = null;
                let executionEntryPrice = reEntryPrice;
                let slOrderId = null;
                let slUniqueOrderId = null;
                let slTriggerPrice = existingSlTrigger;
                let slLimitPrice = null;

                if (!config.is_paper_trading) {
                    // LIVE strategy: place real entry order on broker
                    try {
                        const entrySide = leg.leg.side;
                        const offsetAmt = getLimitOffsetAmt(reEntryPrice, config);
                        const finalPrice = entrySide === "BUY"
                            ? roundToTick(reEntryPrice + offsetAmt).toString()
                            : roundToTick(reEntryPrice - offsetAmt).toString();

                        const entryConfig = {
                            ...config,
                            side: entrySide,
                            variety: "NORMAL",
                            ordertype: "LIMIT",
                            price: finalPrice,
                            lots: leg.leg.lots
                        };

                        const orderData = await placeOrder(entryConfig, instrument, config.connectionId);
                        liveOrderId = orderData.orderid;
                        liveUniqueOrderId = orderData.uniqueorderid;

                        const fillPrice = await chaseOrderFill({
                            orderId: orderData.orderid,
                            uniqueOrderId: orderData.uniqueorderid,
                            instrument,
                            config,
                            legSide: entrySide,
                            lots: leg.leg.lots,
                            connectionId: config.connectionId,
                            strategyId,
                            baseLtp: reEntryPrice,
                            forceLive: true  // strategy.is_virtual is still true in-memory during this transition
                        });

                        if (fillPrice) {
                            executionEntryPrice = fillPrice;
                            addStrategyLog(strategyId, `Re-entered LIVE leg ${instrument.symbol} at ₹${fillPrice}`, "INFO");

                            if (config.variety === "STOPLOSS" && leg.leg.sl_type) {
                                try {
                                    const slOrder = await placeStopLossWithRetry({
                                        baseConfig: config,
                                        legSide: entrySide,
                                        entryPrice: fillPrice,
                                        instrument,
                                        lots: leg.leg.lots,
                                        slType: leg.leg.sl_type,
                                        slValue: leg.leg.sl_value,
                                        slLimitMargin: leg.leg.sl_limit_margin || 0,
                                        slLimitMarginType: leg.leg.sl_limit_margin_type || "POINTS",
                                        connectionId: config.connectionId,
                                        strategyId,
                                        overrideSlTriggerPrice: existingSlTrigger
                                    });
                                    if (slOrder?.orderid) {
                                        slOrderId = slOrder.orderid;
                                        slUniqueOrderId = slOrder.uniqueorderid;
                                        slLimitPrice = slOrder.price;
                                        slTriggerPrice = slOrder.triggerprice;
                                    }
                                } catch (slErr) {
                                    console.error(`[SwitchVirtual] Failed to re-place SL for ${instrument.symbol}: ${slErr.message}`);
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`[SwitchVirtual] Live re-entry failed for ${instrument.symbol}: ${err.message}`);
                        addStrategyLog(strategyId, `Live re-entry FAILED for ${instrument.symbol}: ${err.message}`, "ERROR");
                    }
                } else {
                    addStrategyLog(strategyId, `Re-entered PAPER leg ${instrument.symbol} at ₹${reEntryPrice}`, "INFO");
                }

                // 3. Create a NEW Active Running Leg preserving virtual SL trigger prices
                const newRunningLeg = {
                    leg: { ...leg.leg },
                    instrument: { ...instrument },
                    orderId: liveOrderId || `PAPER-${Date.now()}`,
                    uniqueOrderId: liveUniqueOrderId || `UPAPER-${Date.now()}`,
                    state: "ACTIVE",
                    is_virtual_monitoring: false,
                    is_virtual_leg: false,
                    legIndex: leg.legIndex,
                    exited: false,
                    exitType: null,
                    isExiting: false,
                    entryPrice: executionEntryPrice,
                    currentLtp: reEntryPrice,
                    last_tick_price: reEntryPrice,
                    entryTime: getISTExchangeFormat(),
                    slOrderId: slOrderId,
                    slUniqueOrderId: slUniqueOrderId,
                    slTriggerPrice: slTriggerPrice || existingSlTrigger,
                    initialSlTriggerPrice: leg.initialSlTriggerPrice || existingSlTrigger || slTriggerPrice,
                    slLimitPrice: slLimitPrice,
                    tslReferencePrice: leg.tslReferencePrice,
                    peakPrice: Math.max(executionEntryPrice, leg.peakPrice || 0),
                    rtp: leg.rtp,
                    mtp: leg.mtp,
                    max_peak_price: Math.max(executionEntryPrice, leg.max_peak_price || 0),
                    max_low_price: leg.max_low_price ? Math.min(executionEntryPrice, leg.max_low_price) : executionEntryPrice,
                    re_high_trigger_price: leg.re_high_trigger_price,
                    re_low_trigger_price: leg.re_low_trigger_price,
                    candleMinute: leg.candleMinute,
                    candleHigh: leg.candleHigh,
                    candleLow: leg.candleLow,
                    reentry_count: leg.reentry_count || 0,
                    original_traded_price: executionEntryPrice,
                    base_otp: executionEntryPrice,
                    bookedPnlPoints: 0,
                    bookedPnlRupees: 0,
                    currentActivePnlPoints: 0,
                    currentActivePnlRupees: 0,
                    pnlPercent: 0,
                    pnlPoints: 0,
                    pnlRupees: 0
                };

                newActiveLegsToPush.push(newRunningLeg);
            }
        }

        strategy.legs = [...currentLegs, ...newActiveLegsToPush];
        strategy.is_virtual = false;
        strategy.config.is_virtual = false;

        updateStrategyInMemory(strategyId, {
            is_virtual: false,
            legs: strategy.legs
        });

        addStrategyLog(strategyId, `Strategy switched back from VIRTUAL mode. Re-entered active legs.`, "INFO");
        marketSocketService.sendAlertToUser(strategy.user_id, `Strategy switched back to active mode`, "success");
        return true;
    }
}

module.exports = {
    handleLegStopOut,
    pauseStrategy,
    stopStrategy,
    squareOffStrategy,
    squareOffLeg,
    resumeStrategy,
    switchVirtualMode
};


