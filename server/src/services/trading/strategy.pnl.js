const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");

function checkOverallPnlLimits({ config, totalPnlRupees, avgPnl }) {
    // 1. Check Overall Stop Loss
    const slType = config.overall_sl_type || "PERCENTAGE";
    const slValue = parseFloat(config.overall_sl_value || 0);

    if (config.overall_sl_enabled && slValue > 0) {
        if (slType === "PERCENTAGE" && avgPnl <= -slValue) {
            return { 
                hit: true, 
                exitType: "OVERALL_STOP_LOSS", 
                reason: `Overall SL% (${slValue}%) hit`,
                logLevel: "CRITICAL",
                logMessage: "SQUARING OFF due to Overall Stop Loss hit."
            };
        } else if (slType === "AMOUNT" && totalPnlRupees <= -slValue) {
            return { 
                hit: true, 
                exitType: "OVERALL_STOP_LOSS", 
                reason: `Overall SL₹ (₹${slValue}) hit`,
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
        } else if (targetType === "AMOUNT" && totalPnlRupees >= targetValue) {
            return { 
                hit: true, 
                exitType: "OVERALL_TARGET", 
                reason: `Overall Target₹ (₹${targetValue}) hit`,
                logLevel: "SUCCESS",
                logMessage: "SQUARING OFF due to Overall Target hit."
            };
        }
    }

    return { hit: false };
}

function evaluateLegLimits({ leg, config }) {
    let result = {
        isHit: false,
        exitReason: "LEG_STOP_LOSS",
        tslStepped: false,
        tslUpdates: null,
        initSlReq: false
    };

    // 1. Evaluate Trailing Stop Loss mathematically (Step-based Tracking)
    if (leg.leg.tsl_enabled && leg.tslReferencePrice !== undefined && leg.currentLtp !== null && leg.leg.tsl_move > 0 && leg.leg.tsl_trail > 0) {
        const tslType = leg.leg.tsl_type || "PERCENTAGE";
        const tslMove = parseFloat(leg.leg.tsl_move);
        const tslTrail = parseFloat(leg.leg.tsl_trail);

        let moveThreshold = tslMove;
        let trailAmount = tslTrail;

        if (tslType === "PERCENTAGE") {
            moveThreshold = leg.entryPrice * (tslMove / 100);
            trailAmount = leg.entryPrice * (tslTrail / 100);
        } else if (tslType === "POINTS") {
            moveThreshold = tslMove;
            trailAmount = tslTrail;
        }

        let favorableMove = 0;
        if (leg.leg.side === "BUY") {
            favorableMove = leg.currentLtp - leg.tslReferencePrice;
        } else if (leg.leg.side === "SELL") {
            favorableMove = leg.tslReferencePrice - leg.currentLtp;
        }

        if (favorableMove >= moveThreshold) {
            const steps = Math.floor(favorableMove / moveThreshold);
            const totalTrail = steps * trailAmount;

            if (steps > 0) {
                const oldTrigger = leg.slTriggerPrice;
                let newTrigger = oldTrigger;

                if (leg.leg.side === "BUY") {
                    newTrigger = oldTrigger + totalTrail;
                } else {
                    newTrigger = oldTrigger - totalTrail;
                }

                let isValidTrail = true;
                if (oldTrigger !== null && oldTrigger !== undefined) {
                    isValidTrail = leg.leg.side === "BUY" ? newTrigger > oldTrigger : newTrigger < oldTrigger;
                }

                if (isValidTrail) {
                    const roundedTrigger = roundToTick(newTrigger);
                    const offsetAmt = getLimitOffsetAmt(roundedTrigger, config);
                    const newLimit = roundToTick(leg.leg.side === "BUY" ?
                        roundedTrigger - offsetAmt :
                        roundedTrigger + offsetAmt);
                    
                    const newReferencePrice = leg.leg.side === "BUY"
                        ? leg.tslReferencePrice + (steps * moveThreshold)
                        : leg.tslReferencePrice - (steps * moveThreshold);

                    result.tslStepped = true;
                    result.tslUpdates = {
                        oldTrigger,
                        newTrigger: roundedTrigger,
                        newLimit,
                        newReferencePrice
                    };
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
