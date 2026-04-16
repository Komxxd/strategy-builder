const { globalLtpMap, addStrategyLog, updateStrategyInMemory } = require("./strategy.state");
const { getAuthorizedInstance } = require("../../config/smartapi");
const { handleReentryAsap } = require("./strategy.reentry.asap");
const { handleLazyLeg } = require("./strategy.reentry.lazy");
const { handleReentryCost } = require("./strategy.reentry.cost");
const { checkMomentumHit } = require("./strategy.momentum");
const { getISTTime } = require("./strategy.time");
const { computeStopLossExitPrices, getLimitOffsetAmt } = require("./strategy.offset");
const { placeStopLossWithRetry, placeExitOrder } = require("./strategy.execution");
const { checkOverallPnlLimits, evaluateLegLimits } = require("./strategy.pnl");
const marketSocketService = require("../marketSocket.service");
const { handleLegStopOut, pauseStrategy } = require("./strategy.lifecycle");

async function monitorStrategyLoop(strategyId, strategy) {
    if (!strategy || strategy.status !== "IN_POSITION" || !strategy.legs?.length) return;

    const { config } = strategy;
    const currentTime = getISTTime();

    try {
        const activeLegs = strategy.legs.filter(leg => !(leg.exited && !["WAITING_FOR_RECOST", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY"].includes(leg.state)));
        if (activeLegs.length === 0) return;

        const ltpMap = globalLtpMap;

        for (const leg of activeLegs) {
            // 0. Specialized Re-entry states
            if (leg.state === "WAITING_FOR_RE_ASAP") {
                await handleReentryAsap({ leg, config, strategyId, addStrategyLog });
                continue;
            }
            if (leg.state === "WAITING_FOR_LAZY") {
                await handleLazyLeg({ leg, config, strategyId, addStrategyLog });
                continue;
            }

            const exch = leg.instrument?.exch_seg;
            const token = leg.instrument?.token;
            if (!exch || !token) continue;
            
            const tickPrice = ltpMap[`${exch}_${token}`];

            if (tickPrice !== undefined) {
                leg.currentLtp = tickPrice;

                // 1. Simple Momentum Entry (Paper Only)
                if (leg.state === "WAITING_FOR_SIMPLE_MNTM" && leg.last_tick_price !== null) {
                    const target = leg.mntmTargetPrice;
                    const mntmHit = checkMomentumHit(leg, leg.currentLtp, leg.last_tick_price);

                    if (mntmHit) {
                        leg.entryPrice = target;
                        leg.entryTime = getISTTime();
                        leg.original_traded_price = target;
                        leg.state = "ACTIVE";
                        leg.peakPrice = target;
                        leg.tslReferencePrice = target;
                        addStrategyLog(strategyId, `Simple Momentum Target Reached: ₹${target} for ${leg.instrument.symbol}. Entry triggered.`, "INFO");

                        if (config.variety === "STOPLOSS" && leg.entryPrice && leg.leg.sl_enabled !== false) {
                            const slOrder = await placeStopLossWithRetry({
                                baseConfig: config, legSide: leg.leg.side, entryPrice: leg.entryPrice, instrument: leg.instrument, lots: leg.leg.lots,
                                slType: leg.leg.sl_type || "PERCENTAGE", slValue: leg.leg.stop_loss, slLimitMargin: getLimitOffsetAmt(leg.entryPrice, config),
                                slLimitMarginType: config.entry_limit_offset_type || 'POINTS', connectionId: config.connectionId, strategyId: strategyId
                            });
                            const prices = computeStopLossExitPrices(leg.entryPrice, leg.leg.side, leg.leg.sl_type || "PERCENTAGE", leg.leg.stop_loss, getLimitOffsetAmt(leg.entryPrice, config), config.entry_limit_offset_type || 'POINTS');
                            if (slOrder?.orderid) {
                                leg.slOrderId = slOrder.orderid;
                                leg.slUniqueOrderId = slOrder.uniqueorderid;
                            }
                            leg.slTriggerPrice = prices?.trigger || null;
                            leg.initialSlTriggerPrice = prices?.trigger || null;
                            leg.slLimitPrice = prices?.limit || null;
                        }
                    }
                }

                // 2. Re-Cost Cross Logic
                if (leg.state === "WAITING_FOR_MNTM" && leg.last_tick_price !== null) {
                    const currentTick = leg.currentLtp;
                    const prevTick = leg.last_tick_price;
                    const rtp = leg.recost_trigger_price;
                    let triggerReEntry = false;

                    if (leg.leg.recost_mode.includes("PLUS")) {
                        if (prevTick <= rtp && currentTick >= rtp) triggerReEntry = true;
                    } else {
                        if (prevTick >= rtp && currentTick <= rtp) triggerReEntry = true;
                    }

                    if (triggerReEntry) {
                        await handleReentryCost({ leg, config, strategyId, addStrategyLog, currentTick });
                    }
                }

                leg.last_tick_price = leg.currentLtp;

                // 3. PnL Updates
                if (leg.entryPrice && leg.state === "ACTIVE") {
                    if (leg.peakPrice === undefined || leg.peakPrice === null) leg.peakPrice = leg.entryPrice;
                    if (leg.leg.side === "BUY") {
                        if (leg.currentLtp > leg.peakPrice) leg.peakPrice = leg.currentLtp;
                    } else {
                        if (leg.currentLtp < leg.peakPrice) leg.peakPrice = leg.currentLtp;
                    }

                    const pnlPoints = leg.leg.side === "BUY" ? (leg.currentLtp - leg.entryPrice) : (leg.entryPrice - leg.currentLtp);
                    leg.currentActivePnlPoints = pnlPoints;
                    const quantity = leg.leg.lots * parseInt(leg.instrument.lotsize || 1);
                    leg.currentActivePnlRupees = pnlPoints * quantity;
                    leg.pnlPercent = ((leg.bookedPnlPoints || 0) + pnlPoints) / leg.original_traded_price * 100;
                    leg.currentActivePnlPercent = (pnlPoints / leg.entryPrice) * 100;
                    leg.pnlPoints = (leg.bookedPnlPoints || 0) + leg.currentActivePnlPoints;
                    leg.pnlRupees = (leg.bookedPnlRupees || 0) + leg.currentActivePnlRupees;
                }
            }
        }

        // Global Strategy PnL
        const totalPnlRupees = strategy.legs.reduce((sum, l) => sum + (l.pnlRupees || 0), 0);
        strategy.totalPnlRupees = totalPnlRupees;

        const totalOriginalValue = strategy.legs.reduce((sum, l) => {
            if (!l.original_traded_price) return sum;
            const quantity = (l.leg?.lots || 0) * parseInt(l.instrument?.lotsize || 1);
            return sum + (l.original_traded_price * quantity);
        }, 0);

        const avgPnl = totalOriginalValue > 0 ? (totalPnlRupees / totalOriginalValue) * 100 : 0;
        strategy.pnlPercent = avgPnl;
        strategy.totalOriginalValue = totalOriginalValue;

        // Overall Limit Check
        const limitCheck = checkOverallPnlLimits({ config, totalPnlRupees, avgPnl });
        if (limitCheck.hit) {
            if (strategy.exitAttempted) return;
            strategy.exitAttempted = true;
            addStrategyLog(strategyId, `${limitCheck.logMessage} Final PnL: ₹${totalPnlRupees.toFixed(2)} (${avgPnl.toFixed(2)}%).`, limitCheck.logLevel);

            if (config.variety === "STOPLOSS" && !config.is_paper_trading) {
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
                    return await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: limitCheck.exitType });
                }));
                strategy.status = "COMPLETED";
                strategy.exitOrderId = exitOrders;
                strategy.exitType = limitCheck.exitType;
                updateStrategyInMemory(strategyId, {
                    status: "COMPLETED", exit_order_id: strategy.exitOrderId, exit_type: limitCheck.exitType,
                    final_pnl_percent: avgPnl, totalPnlRupees: totalPnlRupees, totalOriginalValue: strategy.totalOriginalValue, legs: strategy.legs
                });
                return "TERMINATE";
            } catch (exitErr) {
                if (exitErr.message?.startsWith("EXIT_CHASE_EXHAUSTED")) {
                    pauseStrategy(strategyId, `Exit Chase failed during Overall Limit hit: ${exitErr.message}`);
                    return "TERMINATE";
                }
                throw exitErr;
            }
        }

        // Leg Monitoring (TSL/SL)
        for (const leg of strategy.legs) {
            if (leg.exited || leg.state === "WAITING_FOR_RECOST") continue;

            const evalResult = evaluateLegLimits({ leg, config });

            if (evalResult.initSlReq) {
                leg.initialSlTriggerPrice = evalResult.tslUpdates.initTrigger;
                if (!leg.slTriggerPrice) leg.slTriggerPrice = evalResult.tslUpdates.initTrigger;
                if (!leg.slLimitPrice) leg.slLimitPrice = evalResult.tslUpdates.initLimit;
            }

            if (evalResult.tslStepped) {
                const { oldTrigger, newTrigger, newLimit, newReferencePrice } = evalResult.tslUpdates;
                if (config.variety === "STOPLOSS" && !config.is_paper_trading && leg.slOrderId) {
                    try {
                        const api = await getAuthorizedInstance(config.connectionId);
                        await api.modifyOrder({
                            variety: "STOPLOSS", orderid: leg.slOrderId, ordertype: "STOPLOSS_LIMIT", producttype: config.producttype || "CARRYFORWARD",
                            duration: config.duration || "DAY", price: newLimit.toString(), quantity: leg.leg.lots.toString(),
                            tradingsymbol: leg.instrument.symbol, symboltoken: leg.instrument.token, exchange: leg.instrument.exch_seg,
                            triggerprice: newTrigger.toString(),
                        });
                        addStrategyLog(strategyId, `TSL Step: Moved SL for ${leg.instrument.symbol} to ₹${newTrigger}`, "INFO");
                    } catch (e) {}
                } else {
                    addStrategyLog(strategyId, `[PAPER TSL] Virtual SL moved to ₹${newTrigger}`, "INFO");
                }
                leg.slTriggerPrice = newTrigger;
                leg.slLimitPrice = newLimit;
                leg.tslReferencePrice = newReferencePrice;
            }

            if (evalResult.isHit) {
                try {
                    await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: evalResult.exitReason });
                    await handleLegStopOut(leg, evalResult.exitReason, strategy);
                } catch (exitErr) {
                    if (exitErr.message?.startsWith("EXIT_CHASE_EXHAUSTED")) {
                        pauseStrategy(strategyId, `Exit Chase failed for ${leg.instrument?.symbol}: ${exitErr.message}`);
                        return "TERMINATE";
                    }
                    throw exitErr;
                }
            }
        }

        // Live SL Check (Broker State)
        if (config.variety === "STOPLOSS" && config.is_paper_trading !== true) {
            for (const leg of strategy.legs) {
                if (leg.exited || leg.state === "WAITING_FOR_RECOST" || !leg.slUniqueOrderId || leg.exchangeSlProcessed) continue;
                const isNearTrigger = leg.leg.side === "BUY" ? (leg.currentLtp <= leg.slTriggerPrice * 1.02) : (leg.currentLtp >= leg.slTriggerPrice * 0.98);
                if (isNearTrigger) {
                    try {
                        const api = await getAuthorizedInstance(config.connectionId);
                        const details = await api.indOrderDetails(leg.slUniqueOrderId);
                        const orderStatus = (details?.data?.orderstatus || "").toLowerCase();
                        if (orderStatus === "complete" || orderStatus === "filled") {
                            leg.exchangeSlProcessed = true;
                            await handleLegStopOut(leg, "EXCHANGE_STOP_LOSS", strategy);
                        }
                    } catch (err) {}
                }
            }
        }

        // Exit Time Check
        if (currentTime >= config.exit_time) {
            if (strategy.exitAttempted) return;
            strategy.exitAttempted = true;
            addStrategyLog(strategyId, `Exit Time ${config.exit_time} reached. Squaring off all legs.`, "INFO");

            if (!config.is_paper_trading) {
                await Promise.all(strategy.legs.map(async (leg) => {
                    if (leg.exited) return;
                    try {
                        const api = await getAuthorizedInstance(config.connectionId);
                        if (leg.slOrderId) await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.slOrderId });
                        if (!leg.entryPrice && leg.orderId) {
                             try { await api.cancelOrder({ variety: "NORMAL", orderid: leg.orderId }); } catch (e) { await api.cancelOrder({ variety: "STOPLOSS", orderid: leg.orderId }); }
                        }
                    } catch (e) {}
                }));
            }

            try {
                const exitOrders = await Promise.all(strategy.legs.map(async (leg) => {
                    if (leg.exited) return leg.exitOrderId;
                    return await placeExitOrder({ config, leg, instrument: leg.instrument, exitType: "EXIT_TIME" });
                }));

                strategy.status = "COMPLETED";
                updateStrategyInMemory(strategyId, {
                    status: "COMPLETED", exit_order_id: exitOrders, exit_type: "EXIT_TIME", final_pnl_percent: strategy.pnlPercent,
                    totalPnlRupees: strategy.totalPnlRupees, totalOriginalValue: strategy.totalOriginalValue, legs: strategy.legs
                });
                return "TERMINATE";
            } catch (exitErr) {
                if (exitErr.message?.startsWith("EXIT_CHASE_EXHAUSTED")) {
                    pauseStrategy(strategyId, `Square-off chase failed at Exit Time: ${exitErr.message}`);
                    return "TERMINATE";
                }
                throw exitErr;
            }
        }

        // All Legs Completed Check
        if (strategy.legs.every(l => l.exited)) {
            strategy.status = "COMPLETED";
            updateStrategyInMemory(strategyId, {
                status: "COMPLETED", exit_type: "LEGS_COMPLETED", final_pnl_percent: strategy.pnlPercent,
                totalPnlRupees: strategy.totalPnlRupees, legs: strategy.legs
            });
            return "TERMINATE";
        }

    } catch (err) {
        console.error(`[${strategyId}] Monitor Loop Error:`, err.message);
    }
}

module.exports = {
    monitorStrategyLoop
};
