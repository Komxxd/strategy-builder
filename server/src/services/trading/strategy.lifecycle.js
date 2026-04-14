const { getISTTime } = require("./strategy.time");
const { addStrategyLog, activeStrategies, updateStrategyInMemory } = require("./strategy.state");
const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, waitForOrderFillPrice, placeStopLossWithRetry } = require("./strategy.execution");

async function handleLegStopOut(leg, exitType, strategy) {
    const strategyId = strategy.id;
    const config = strategy.config;
    
    // 1. Lock PnL and Mark CURRENT leg as completely exited
    leg.state = "COMPLETED";
    leg.exited = true;
    leg.exitType = exitType;
    leg.bookedPnlPoints = (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0);
    leg.bookedPnlRupees = (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0);
    leg.currentActivePnlPoints = 0;
    leg.currentActivePnlRupees = 0;

    // Capture the exact trigger and execution price at the very millisecond of stop-out for the UI history
    leg.exitSnapshot = {
        slTriggerPrice: leg.slTriggerPrice,
        exitLtp: leg.currentLtp,
        exitTime: getISTTime()
    };
    leg.exitTime = getISTTime();

    // Wipe exchange fields to ensure clean exit visualization
    leg.slOrderId = null;
    leg.slUniqueOrderId = null;
    leg.slLimitPrice = null;
    leg.slTriggerPrice = null;
    leg.exchangeSlProcessed = true;

    addStrategyLog(strategyId, `Leg stopped out: ${leg.instrument?.symbol || 'Unknown'}. Reason: ${exitType}. PnL: ₹${(leg.pnlRupees || 0).toFixed(2)}`, exitType.includes("ERROR") ? "ERROR" : "INFO");

    // RE ASAP (Re-Entry As Soon As Possible)
    if (leg.leg.re_asap_enabled && (leg.reentry_count < (leg.leg.re_asap_max_entries || 1))) {
        addStrategyLog(strategyId, `RE ASAP triggered for ${leg.instrument?.symbol || "leg"}. Re-calculating entry for reentry #${leg.reentry_count + 1}`, "INFO");

        const newLeg = {
            leg: { ...leg.leg },
            instrument: null, // To be re-selected on next tick
            orderId: `VU-ASAP-${Date.now()}`,
            uniqueOrderId: `VU-ASAP-${Date.now()}`,
            state: "WAITING_FOR_RE_ASAP",
            legIndex: leg.legIndex,
            exited: false,
            exitType: null,
            isExiting: false,
            entryPrice: null,
            currentLtp: leg.currentLtp,
            last_tick_price: leg.currentLtp,
            reentry_count: leg.reentry_count + 1,
            original_traded_price: 0,
            base_otp: leg.base_otp || leg.original_traded_price,
            bookedPnlPoints: (leg.bookedPnlPoints || 0) + (leg.currentActivePnlPoints || 0),
            bookedPnlRupees: (leg.bookedPnlRupees || 0) + (leg.currentActivePnlRupees || 0),
            currentActivePnlPoints: 0,
            currentActivePnlRupees: 0,
            pnlPercent: leg.pnlPercent || 0,
            pnlPoints: leg.pnlPoints || 0,
            pnlRupees: leg.pnlRupees || 0,
            slOrderId: null,
            slUniqueOrderId: null,
            slTriggerPrice: null,
            slLimitPrice: null,
            exchangeSlProcessed: false
        };
        strategy.legs.push(newLeg);
        return;
    }

    // RE-COST (Re-Entry at Cost)
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
                mtp: null,
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
            state: "ACTIVE", 
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
            exchangeSlProcessed: false
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

            setTimeout(async () => {
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
                    newLeg.entryPrice = fill || currentLtp;
                    newLeg.entryTime = getISTTime();
                    newLeg.original_traded_price = newLeg.entryPrice;
                } catch (e) {
                    newLeg.entryPrice = currentLtp;
                    newLeg.entryTime = getISTTime();
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
            }, 1000);
        } catch (err) {
            console.error("[RE-COST] Immediate Re-entry failed. Halting leg completely.", err);
            newLeg.state = "COMPLETED";
            newLeg.exited = true;
        }
        return;
    }

    // LAZY LEG
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
        _pausedAt: new Date().toISOString()
    });

    const marketSocketService = require("../marketSocket.service");
    marketSocketService.sendAlert(`Strategy PAUSED — ${reason}`, "error");
}

async function squareOffStrategy(strategyId) {
    const { activeStrategies, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
    const { getAuthorizedInstance } = require("../../config/smartapi");
    const { placeExitOrder } = require("./strategy.execution");
    const { pauseStrategy } = require("./strategy.lifecycle");

    const strategy = activeStrategies.get(strategyId);
    if (!strategy) throw new Error("Strategy not found");
    if (strategy.status !== "IN_POSITION") throw new Error('Strategy must be in IN_POSITION to be squared off');

    if (strategy.exitAttempted) throw new Error('Exit already in progress');
    strategy.exitAttempted = true;
    
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
            status: "COMPLETED", exit_type: "MANUAL_SQUARE_OFF", totalPnlRupees: strategy.totalPnlRupees || 0
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
    squareOffStrategy,
    squareOffLeg,
    resumeStrategy
};
