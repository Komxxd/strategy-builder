const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");

function checkOverallPnlLimits({ config, totalPnlRupees, avgPnl, isMinuteClose }) {
    // 1. Check Overall Stop Loss
    // If "On Close" is enabled for SL, only check at minute close (second 59)
    const slOnClose = config.overall_sl_on_close === true;
    const skipSl = slOnClose && !isMinuteClose;

    const slType = config.overall_sl_type || "PERCENTAGE";
    const slValue = parseFloat(config.overall_sl_value || 0);

    const multiplier = parseFloat(config.quantity_multiplier) || 1;
    if (!skipSl && config.overall_sl_enabled && slValue > 0) {
        if (slType === "PERCENTAGE" && avgPnl <= -slValue) {
            return {
                hit: true,
                exitType: "OVERALL_STOP_LOSS",
                reason: `Overall SL% (${slValue}%) hit`,
                logLevel: "CRITICAL",
                logMessage: `SQUARING OFF due to Overall Stop Loss hit${slOnClose ? " (On Close)" : ""}.`
            };
        } else if (slType === "AMOUNT" && totalPnlRupees <= -(slValue * multiplier)) {
            return {
                hit: true,
                exitType: "OVERALL_STOP_LOSS",
                reason: `Overall SL₹ (₹${(slValue * multiplier).toFixed(2)}) hit`,
                logLevel: "CRITICAL",
                logMessage: `SQUARING OFF due to Overall Stop Loss hit${slOnClose ? " (On Close)" : ""}.`
            };
        }
    }

    // 2. Check Overall Target
    // If "On Close" is enabled for Target, only check at minute close (second 59)
    const targetOnClose = config.overall_target_on_close === true;
    const skipTarget = targetOnClose && !isMinuteClose;

    const targetType = config.overall_target_type || "PERCENTAGE";
    const targetValue = parseFloat(config.overall_target_value || 0);

    if (!skipTarget && config.overall_target_enabled && targetValue > 0) {
        if (targetType === "PERCENTAGE" && avgPnl >= targetValue) {
            return {
                hit: true,
                exitType: "OVERALL_TARGET",
                reason: `Overall Target% (${targetValue}%) hit`,
                logLevel: "SUCCESS",
                logMessage: `SQUARING OFF due to Overall Target hit${targetOnClose ? " (On Close)" : ""}.`
            };
        } else if (targetType === "AMOUNT" && totalPnlRupees >= (targetValue * multiplier)) {
            return {
                hit: true,
                exitType: "OVERALL_TARGET",
                reason: `Overall Target₹ (₹${(targetValue * multiplier).toFixed(2)}) hit`,
                logLevel: "SUCCESS",
                logMessage: `SQUARING OFF due to Overall Target hit${targetOnClose ? " (On Close)" : ""}.`
            };
        }
    }

    return { hit: false };
}

function evaluateLegLimits({ leg, config, strategyId, addStrategyLog, isMinuteClose }) {
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

    // Removed verbose TSL debug logging

    // On Close: If tsl_on_close is enabled, only evaluate TSL at minute close (second 59)
    const tslOnClose = isTslOverride
        ? (leg.leg.reentry_tsl_on_close === true)
        : (leg.leg.tsl_on_close === true);
    const skipTsl = tslOnClose && !isMinuteClose;

    if (isTslEnabled && leg.tslReferencePrice !== undefined && leg.currentLtp !== null) {
        if (!skipTsl && !isNaN(tslMove) && !isNaN(tslTrail) && tslMove > 0 && tslTrail > 0) {
            let moveThreshold = tslMove;
            let trailAmount = tslTrail;

            if (tslType === "PERCENTAGE") {
                moveThreshold = (leg.entryPrice || 0) * (tslMove / 100);
                trailAmount = (leg.entryPrice || 0) * (tslTrail / 100);
            }

            // Determine which price to use for TSL step evaluation.
            // On Close Low (SELL): use the candle's intra-minute low.
            // On Close High (BUY): use the candle's intra-minute high.
            // Plain On Close / non-on-close: use currentLtp as always.
            const tslOnCloseLow = isTslOverride
                ? (leg.leg.reentry_tsl_on_close_low === true)
                : (leg.leg.tsl_on_close_low === true);
            const tslOnCloseHigh = isTslOverride
                ? (leg.leg.reentry_tsl_on_close_high === true)
                : (leg.leg.tsl_on_close_high === true);

            let effectiveLtp = leg.currentLtp;
            if (tslOnCloseLow && leg.leg.side === "SELL" && leg.candleLow != null) {
                effectiveLtp = leg.candleLow;
            } else if (tslOnCloseHigh && leg.leg.side === "BUY" && leg.candleHigh != null) {
                effectiveLtp = leg.candleHigh;
            }


            if (moveThreshold > 0) {
                let favorableMove = 0;
                if (leg.leg.side === "BUY") {
                    favorableMove = (effectiveLtp || 0) - (leg.tslReferencePrice || leg.entryPrice || 0);
                } else if (leg.leg.side === "SELL") {
                    favorableMove = (leg.tslReferencePrice || leg.entryPrice || 0) - (effectiveLtp || 0);
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
                result.isHit = true;
                result.exitReason = "TRAILING_STOP_LOSS";
                const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
                const isPaperTrading = config?.is_paper_trading === true || isVirtual;
                if (config.variety === "STOPLOSS" && !isPaperTrading && leg.slOrderId) {
                    result.requiresExchangeValidation = true;
                }
                return result;
            } else if (leg.leg.side === "SELL" && leg.currentLtp >= activeTrigger) {
                result.isHit = true;
                result.exitReason = "TRAILING_STOP_LOSS";
                const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
                const isPaperTrading = config?.is_paper_trading === true || isVirtual;
                if (config.variety === "STOPLOSS" && !isPaperTrading && leg.slOrderId) {
                    result.requiresExchangeValidation = true;
                }
                return result;
            }
        }
    }

    // 2. Evaluate Static Stop Loss (if not already hit by TSL)
    if (!result.isHit) {
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
                const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
            const isPaperTrading = config?.is_paper_trading === true || isVirtual;
            if (config.variety === "STOPLOSS" && !isPaperTrading && leg.slOrderId) {
                    result.requiresExchangeValidation = true;
                }
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
