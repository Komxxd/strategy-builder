const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");

function checkOverallPnlLimits({ config, totalPnlRupees, avgPnl }) {
    // 1. Check Overall Stop Loss
    const slType = config.overall_sl_type || "PERCENTAGE";
    const slValue = parseFloat(config.overall_sl_value || 0);

    const multiplier = parseFloat(config.quantity_multiplier) || 1;
    if (config.overall_sl_enabled && slValue > 0) {
        if (slType === "PERCENTAGE" && avgPnl <= -slValue) {
            return { 
                hit: true, 
                exitType: "OVERALL_STOP_LOSS", 
                reason: `Overall SL% (${slValue}%) hit`,
                logLevel: "CRITICAL",
                logMessage: "SQUARING OFF due to Overall Stop Loss hit."
            };
        } else if (slType === "AMOUNT" && totalPnlRupees <= -(slValue * multiplier)) {
            return { 
                hit: true, 
                exitType: "OVERALL_STOP_LOSS", 
                reason: `Overall SL₹ (₹${(slValue * multiplier).toFixed(2)}) hit`,
                logLevel: "CRITICAL",
                logMessage: "SQUARING OFF due to Overall Stop Loss hit."
            };
        }
    }

    // 2. Check Overall Target
    const targetType = config.overall_target_type || "PERCENTAGE";
    const targetValue = parseFloat(config.overall_target_value || 0);

    if (config.overall_target_enabled && targetValue > 0) {
        if (targetType === "PERCENTAGE" && avgPnl >= targetValue) {
            return { 
                hit: true, 
                exitType: "OVERALL_TARGET", 
                reason: `Overall Target% (${targetValue}%) hit`,
                logLevel: "SUCCESS",
                logMessage: "SQUARING OFF due to Overall Target hit."
            };
        } else if (targetType === "AMOUNT" && totalPnlRupees >= (targetValue * multiplier)) {
            return { 
                hit: true, 
                exitType: "OVERALL_TARGET", 
                reason: `Overall Target₹ (₹${(targetValue * multiplier).toFixed(2)}) hit`,
                logLevel: "SUCCESS",
                logMessage: "SQUARING OFF due to Overall Target hit."
            };
        }
    }

    return { hit: false };
}

function evaluateLegLimits({ leg, config, strategyId, addStrategyLog }) {
    let result = {
        isHit: false,
        exitReason: "LEG_STOP_LOSS",
        tslStepped: false,
        tslUpdates: null,
        initSlReq: false
    };

    // 1. Evaluate Trailing Stop Loss mathematically (Step-based Tracking)
    const isReentered = leg.reentry_count > 0;
    // 1. If SL Override is ON, TSL only exists if TSL Override is also ON.
    // 2. If SL Override is OFF, we fallback to the original leg's TSL settings.
    const isSlOverride = isReentered && leg.leg.reentry_sl_enabled === true;
    const isTslOverride = isSlOverride && leg.leg.reentry_tsl_enabled === true;
    
    const isTslEnabled = isSlOverride 
        ? (leg.leg.reentry_tsl_enabled === true) 
        : (leg.leg.tsl_enabled || false);

    const tslType = isTslOverride ? (leg.leg.reentry_tsl_type || "PERCENTAGE") : (leg.leg.tsl_type || "PERCENTAGE");
    let tslMove = isTslOverride ? parseFloat(leg.leg.reentry_tsl_move || 0) : parseFloat(leg.leg.tsl_move || 0);
    let tslTrail = isTslOverride ? parseFloat(leg.leg.reentry_tsl_trail || 0) : parseFloat(leg.leg.tsl_trail || 0);

    // SAFETY FALLBACK: If override values are 0/NaN but original values exist, use them.
    if (isTslOverride && (isNaN(tslMove) || tslMove <= 0)) {
        tslMove = parseFloat(leg.leg.tsl_move || 0);
    }
    if (isTslOverride && (isNaN(tslTrail) || tslTrail <= 0)) {
        tslTrail = parseFloat(leg.leg.tsl_trail || 0);
    }

    if (addStrategyLog && strategyId) {
        if (!leg._tsl_debug_tick || leg._tsl_debug_tick % 20 === 0) {
            addStrategyLog(strategyId, `[TSL-RE-DEBUG] Leg ${leg.instrument?.symbol}: isSlOv: ${isSlOverride}, isTslOv: ${isTslOverride}, isTslEn: ${isTslEnabled}, Ref: ${leg.tslReferencePrice}, LTP: ${leg.currentLtp}, SL: ${leg.slTriggerPrice}, MoveVal: ${tslMove}`, "INFO");
            
            // ONE-TIME RAW CONFIG LOG (to dashboard for visibility)
            if (isReentered && tslMove === 0 && !leg._raw_config_logged) {
                addStrategyLog(strategyId, `[RAW-CONFIG] ${leg.instrument?.symbol}: ${JSON.stringify(leg.leg).substring(0, 500)}`, "WARNING");
                leg._raw_config_logged = true;
            }
        }
        leg._tsl_debug_tick = (leg._tsl_debug_tick || 0) + 1;
    }

    if (isTslEnabled && leg.tslReferencePrice !== undefined && leg.currentLtp !== null) {
        if (!isNaN(tslMove) && !isNaN(tslTrail) && tslMove > 0 && tslTrail > 0) {
            let moveThreshold = tslMove;
            let trailAmount = tslTrail;

            if (tslType === "PERCENTAGE") {
                moveThreshold = (leg.entryPrice || 0) * (tslMove / 100);
                trailAmount = (leg.entryPrice || 0) * (tslTrail / 100);
            }

            if (moveThreshold > 0 && addStrategyLog && strategyId && leg.reentry_count > 0) {
                 // Log once every 10 ticks to avoid spam
                 if (!leg._tsl_log_tick || leg._tsl_log_tick % 20 === 0) {
                    addStrategyLog(strategyId, `[TSL-CHECK] Leg ${leg.instrument?.symbol} (#${leg.reentry_count}): RefPrice: ₹${(leg.tslReferencePrice || leg.entryPrice || 0).toFixed(2)}, LTP: ₹${(leg.currentLtp || 0).toFixed(2)}, Threshold: ${moveThreshold.toFixed(2)}, Type: ${tslType}`, "INFO");
                 }
                 leg._tsl_log_tick = (leg._tsl_log_tick || 0) + 1;
            }

            if (moveThreshold > 0) {
                let favorableMove = 0;
                if (leg.leg.side === "BUY") {
                    favorableMove = (leg.currentLtp || 0) - (leg.tslReferencePrice || leg.entryPrice || 0);
                } else if (leg.leg.side === "SELL") {
                    favorableMove = (leg.tslReferencePrice || leg.entryPrice || 0) - (leg.currentLtp || 0);
                }

                if (favorableMove >= moveThreshold) {
                    const steps = Math.floor(favorableMove / moveThreshold);
                    const totalTrail = steps * trailAmount;

                    if (steps > 0) {
                        const oldTrigger = leg.slTriggerPrice;
                        let newTrigger = oldTrigger;

                        if (oldTrigger !== null && oldTrigger !== undefined) {
                            if (leg.leg.side === "BUY") {
                                newTrigger = oldTrigger + totalTrail;
                            } else {
                                newTrigger = oldTrigger - totalTrail;
                            }

                            let isValidTrail = leg.leg.side === "BUY" ? newTrigger > oldTrigger : newTrigger < oldTrigger;

                            if (isValidTrail) {
                                const roundedTrigger = roundToTick(newTrigger);
                                const offsetAmt = getLimitOffsetAmt(roundedTrigger, config);
                                const newLimit = roundToTick(leg.leg.side === "BUY" ?
                                    roundedTrigger - offsetAmt :
                                    roundedTrigger + offsetAmt);
                                
                                const newReferencePrice = leg.leg.side === "BUY"
                                    ? (leg.tslReferencePrice || leg.entryPrice) + (steps * moveThreshold)
                                    : (leg.tslReferencePrice || leg.entryPrice) - (steps * moveThreshold);

                                result.tslStepped = true;
                                result.tslUpdates = {
                                    oldTrigger,
                                    newTrigger: roundedTrigger,
                                    newLimit,
                                    newReferencePrice
                                };
                            }
                        } else {
                            if (leg.reentry_count > 0 && addStrategyLog && strategyId) {
                                // This is the crucial log - why is it not trailing?
                                addStrategyLog(strategyId, `[TSL-DEBUG] ${leg.instrument?.symbol} Re-entry #${leg.reentry_count}: Favorable move ${favorableMove.toFixed(2)} >= Threshold ${moveThreshold.toFixed(2)}, but slTriggerPrice is missing.`, "WARNING");
                            }
                        }
                    }
                }
            }
        }

        const activeTrigger = result.tslStepped ? result.tslUpdates.newTrigger : leg.slTriggerPrice;
        if (activeTrigger) {
            if (leg.leg.side === "BUY" && leg.currentLtp <= activeTrigger) {
                if (config.variety !== "STOPLOSS" || config.is_paper_trading === true || !leg.slOrderId) {
                    result.isHit = true;
                    result.exitReason = "TRAILING_STOP_LOSS";
                    return result; 
                }
            } else if (leg.leg.side === "SELL" && leg.currentLtp >= activeTrigger) {
                if (config.variety !== "STOPLOSS" || config.is_paper_trading === true || !leg.slOrderId) {
                    result.isHit = true;
                    result.exitReason = "TRAILING_STOP_LOSS";
                    return result;
                }
            }
        }
    }

    // 2. Evaluate Static Stop Loss (if not already hit by TSL)
    if (!result.isHit && (config.variety !== "STOPLOSS" || config.is_paper_trading === true || !leg.slOrderId)) {
        const isReentered = leg.reentry_count > 0;
        const activeSlValue = isReentered && leg.leg.reentry_sl_enabled ? parseFloat(leg.leg.reentry_sl_value || 0) : parseFloat(leg.leg.stop_loss || 0);
        const isSlEnabled = isReentered && leg.leg.reentry_sl_enabled ? true : leg.leg.sl_enabled !== false;

        if (isSlEnabled && activeSlValue > 0) {
            const activeSlType = isReentered && leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");

            if (activeSlType === "POINTS") {
                result.isHit = leg.currentActivePnlPoints <= -activeSlValue;
            } else {
                result.isHit = leg.currentActivePnlPercent <= -activeSlValue;
            }

            if (result.isHit) {
                result.exitReason = "LEG_STOP_LOSS";
            }

            if (leg.initialSlTriggerPrice === undefined || leg.initialSlTriggerPrice === null) {
                const offsetAmount = getLimitOffsetAmt(leg.entryPrice, config);
                const prices = computeStopLossExitPrices(
                    leg.entryPrice,
                    leg.leg.side,
                    activeSlType,
                    activeSlValue,
                    offsetAmount, 
                    'POINTS'
                );
                
                if (prices) {
                    if (!result.tslUpdates) result.tslUpdates = {};
                    result.tslUpdates.initTrigger = prices.trigger;
                    result.tslUpdates.initLimit = prices.limit;
                    result.initSlReq = true;
                }
            }
        }
    }

    return result;
}

module.exports = {
    checkOverallPnlLimits,
    evaluateLegLimits
};
