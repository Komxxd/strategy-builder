const { roundToTick, getLimitOffsetAmt, computeStopLossExitPrices } = require("./strategy.offset");
const { placeOrder, placeStopLossWithRetry, resolveReentryOrderFill, handleReentryPlacementError } = require("./strategy.execution");
const { getISTTime, getISTExchangeFormat, isWithinSecondsOfExit } = require("./strategy.time");

/**
 * Calculates the RTP for RE_HIGH or RE_LOW from a tracked peak/low price.
 */
function calcExtremumRtp(extremumPrice, isHigh, mode, value) {
    const val = parseFloat(value || 0);
    let calcRtp = extremumPrice;
    if (isHigh) {
        if (mode === "REHIGH_MINUS_PCT") calcRtp = extremumPrice - (extremumPrice * val / 100);
        else if (mode === "REHIGH_MINUS_PTS") calcRtp = extremumPrice - val;
    } else {
        if (mode === "RELOW_PLUS_PCT") calcRtp = extremumPrice + (extremumPrice * val / 100);
        else if (mode === "RELOW_PLUS_PTS") calcRtp = extremumPrice + val;
        else if (mode === "RELOW_MINUS_PCT") calcRtp = extremumPrice - (extremumPrice * val / 100);
        else if (mode === "RELOW_MINUS_PTS") calcRtp = extremumPrice - val;
    }
    return roundToTick(calcRtp);
}

/**
 * Calculates MTP from a base RTP when re-entry momentum is enabled.
 */
function calcConditionMtp(baseRtp, mntmEnabled, mntmMode = "PLUS_PCT", mntmVal = 0) {
    if (!mntmEnabled || baseRtp == null) return null;
    const val = parseFloat(mntmVal || 0);
    let mtp = baseRtp;
    if (mntmMode.includes("PLUS_PCT") || mntmMode === "PERCENTAGE") mtp = baseRtp + (baseRtp * val / 100);
    else if (mntmMode.includes("PLUS_PTS") || mntmMode === "POINTS") mtp = baseRtp + val;
    else if (mntmMode.includes("MINUS_PCT")) mtp = baseRtp - (baseRtp * val / 100);
    else if (mntmMode.includes("MINUS_PTS")) mtp = baseRtp - val;
    return roundToTick(mtp);
}

/**
 * Tracks intra-minute peak/low for RE_HIGH and RE_LOW.
 * When rtpOnClose is enabled, UI-facing peak/low and RTP only change at candle close commit.
 */
function updateExtremumTracker({
    tracker,
    isHigh,
    rtpOnClose,
    mode,
    val,
    tickPrice,
    currentMinute,
    currentSeconds,
    mntmEnabled,
    mntmMode,
    mntmVal,
    isRtpMet = false,
    triggerKey = null,
    syncLeg = null,
    addStrategyLog,
    strategyId,
    symbol = "leg",
    logNewExtremum = true
}) {
    const extremumKey = isHigh ? "max_peak_price" : "max_low_price";
    const liveKey = isHigh ? "live_peak_price" : "live_low_price";
    const committedKey = isHigh ? "committed_peak_price" : "committed_low_price";
    const tag = isHigh ? "RE-HIGH" : "RE-LOW";
    const label = isHigh ? "Peak" : "Low";
    const isBetter = (price, prev) => (isHigh ? (!prev || price > prev) : (!prev || price < prev));

    const applyCommit = (extremum, reasonLabel) => {
        const commitRtp = calcExtremumRtp(extremum, isHigh, mode, val);
        const changed = (tracker.committed_rtp !== commitRtp || tracker[committedKey] !== extremum);
        tracker[committedKey] = extremum;
        tracker[extremumKey] = extremum;
        tracker.committed_rtp = commitRtp;
        tracker.rtp = commitRtp;
        if (triggerKey) tracker[triggerKey] = commitRtp;
        if (mntmEnabled) {
            tracker.mtp = calcConditionMtp(commitRtp, true, mntmMode, mntmVal);
        }
        if (syncLeg) syncLeg(extremum);
        if (changed && addStrategyLog) {
            addStrategyLog(
                strategyId,
                `[${tag}] ${reasonLabel} for ${symbol} — Committing ${label}: ₹${extremum}, RTP: ₹${commitRtp}`,
                "INFO"
            );
        }
    };

    if (rtpOnClose) {
        // Fallback commit if second 59 was skipped by loop timing before rolling to a new minute.
        if (
            !isRtpMet &&
            tracker.last_track_minute &&
            tracker.last_track_minute !== currentMinute &&
            tracker.last_commit_minute !== tracker.last_track_minute
        ) {
            const pendingExtremum = tracker[liveKey] ?? tracker[extremumKey];
            if (pendingExtremum != null) {
                applyCommit(pendingExtremum, "Candle Close");
            }
            tracker.last_commit_minute = tracker.last_track_minute;
            tracker.prev_committed_rtp = undefined;
        }

        let isNewExtremum = false;
        if (!isRtpMet) {
            const prevLive = tracker[liveKey] ?? tracker[extremumKey];
            if (isBetter(tickPrice, prevLive)) {
                tracker[liveKey] = tickPrice;
                isNewExtremum = true;
            } else if (tracker[liveKey] == null) {
                tracker[liveKey] = prevLive;
            }
            tracker.last_track_minute = currentMinute;
        }

        const committedExtremum = tracker[committedKey] ?? tracker[extremumKey];
        tracker[extremumKey] = committedExtremum;
        if (syncLeg) syncLeg(committedExtremum);

        const activeCommittedRtp = tracker.committed_rtp !== undefined
            ? tracker.committed_rtp
            : calcExtremumRtp(tracker[liveKey] ?? committedExtremum, isHigh, mode, val);
        tracker.rtp = activeCommittedRtp;
        if (triggerKey) tracker[triggerKey] = activeCommittedRtp;

        // If :59 already committed for the next minute on an earlier tick in :59, keep checking this minute against pre-close RTP.
        const checkRtp = (tracker.last_commit_minute === currentMinute && tracker.prev_committed_rtp !== undefined)
            ? tracker.prev_committed_rtp
            : activeCommittedRtp;

        if (mntmEnabled && !isRtpMet) {
            tracker.mtp = calcConditionMtp(checkRtp, true, mntmMode, mntmVal);
        }

        const commitAtClose = (stillWaiting) => {
            if (!stillWaiting || currentSeconds !== 59) return;
            if (tracker.last_commit_minute !== currentMinute) {
                tracker.prev_committed_rtp = tracker.committed_rtp;
            }
            const extremumToCommit = tracker[liveKey] ?? tracker[extremumKey];
            if (extremumToCommit != null) {
                applyCommit(extremumToCommit, "Candle Close");
            }
            tracker.last_commit_minute = currentMinute;
        };

        return { isNewExtremum, extremum: committedExtremum, checkRtp, commitAtClose };
    }

    let isNewExtremum = false;
    if (!isRtpMet && isBetter(tickPrice, tracker[extremumKey])) {
        tracker[extremumKey] = tickPrice;
        tracker[liveKey] = tickPrice;
        isNewExtremum = true;
    }

    const displayExtremum = tracker[extremumKey];
    if (syncLeg) syncLeg(displayExtremum);
    if (logNewExtremum && isNewExtremum && !isRtpMet && addStrategyLog) {
        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] [${tag}] New ${label.toLowerCase()} reached for ${symbol}: ₹${displayExtremum}`, "INFO");
    }

    const rtp = calcExtremumRtp(displayExtremum, isHigh, mode, val);
    if (!isRtpMet) {
        tracker.rtp = rtp;
        if (triggerKey) tracker[triggerKey] = rtp;
        if (mntmEnabled) {
            tracker.mtp = calcConditionMtp(rtp, true, mntmMode, mntmVal);
        }
    }

    return {
        isNewExtremum,
        extremum: displayExtremum,
        checkRtp: tracker.rtp ?? rtp,
        commitAtClose: () => {}
    };
}

/**
 * Initializes a new waiting leg for re-entry conditions when a leg stops out.
 */
function initReentryConditionsLeg({
    strategy,
    leg,
    config,
    strategyId,
    addStrategyLog,
    slHitMinute
}) {
    const otp = leg.base_otp || leg.original_traded_price || leg.entryPrice;
    const slPrice = leg.base_sl_price || leg.currentLtp || leg.exitSnapshot?.exitLtp || otp;
    const currentLtp = leg.currentLtp || slPrice || otp;

    const rawConditions = (
        (Array.isArray(leg.leg?.reentry_conditions) && leg.leg.reentry_conditions.length > 0 ? leg.leg.reentry_conditions : null) ||
        (Array.isArray(leg.reentry_conditions) && leg.reentry_conditions.length > 0 ? leg.reentry_conditions : null) ||
        (Array.isArray(config?.legs?.[leg.legIndex]?.reentry_conditions) && config.legs[leg.legIndex].reentry_conditions.length > 0 ? config.legs[leg.legIndex].reentry_conditions : null) ||
        (Array.isArray(leg.reentry_conditions_state) && leg.reentry_conditions_state.length > 0 ? leg.reentry_conditions_state : null) ||
        []
    ).slice(0, 5);

    const conditionsState = rawConditions.map((cond, idx) => {
        const type = cond.type || "RE_COST";
        const operator = idx === 0 ? "OR" : (cond.operator || "OR");
        let rtp = currentLtp;
        let peakPrice = null;
        let lowPrice = null;

        if (type === "RE_COST") {
            const mode = cond.recost_mode || "RECOST_PLUS_PCT";
            const val = parseFloat(cond.recost_value || 0);
            let calcRtp = otp;
            if (mode === "RECOST_PLUS_PCT") calcRtp = otp + (otp * val / 100);
            else if (mode === "RECOST_PLUS_PTS") calcRtp = otp + val;
            else if (mode === "RECOST_MINUS_PCT") calcRtp = otp - (otp * val / 100);
            else if (mode === "RECOST_MINUS_PTS") calcRtp = otp - val;
            rtp = roundToTick(calcRtp);
        } else if (type === "RE_SL") {
            const mode = cond.resl_mode || "RESL_PLUS_PCT";
            const val = parseFloat(cond.resl_value || 0);
            let calcRtp = slPrice;
            if (mode === "RESL_PLUS_PCT") calcRtp = slPrice + (slPrice * val / 100);
            else if (mode === "RESL_PLUS_PTS") calcRtp = slPrice + val;
            else if (mode === "RESL_MINUS_PCT") calcRtp = slPrice - (slPrice * val / 100);
            else if (mode === "RESL_MINUS_PTS") calcRtp = slPrice - val;
            rtp = roundToTick(calcRtp);
        } else if (type === "RE_HIGH") {
            peakPrice = slPrice || currentLtp;
            rtp = calcExtremumRtp(peakPrice, true, cond.rehigh_mode || "REHIGH_MINUS_PTS", cond.rehigh_value);
        } else if (type === "RE_LOW") {
            lowPrice = slPrice || currentLtp;
            rtp = calcExtremumRtp(lowPrice, false, cond.relow_mode || "RELOW_PLUS_PTS", cond.relow_value);
        }

        const mtp = calcConditionMtp(rtp, !!cond.mntm_enabled, cond.mntm_mode || "PLUS_PCT", cond.mntm_value || 0);

        let committed_rtp = undefined;
        let committed_peak_price = undefined;
        let committed_low_price = undefined;
        if (type === "RE_HIGH" && cond.rehigh_rtp_on_close) {
            committed_rtp = rtp;
            committed_peak_price = peakPrice;
        } else if (type === "RE_LOW" && cond.relow_rtp_on_close) {
            committed_rtp = rtp;
            committed_low_price = lowPrice;
        }

        return {
            ...cond,
            id: cond.id || `cond_${idx}`,
            type,
            operator,
            rtp,
            mtp,
            max_peak_price: peakPrice,
            max_low_price: lowPrice,
            live_peak_price: peakPrice,
            live_low_price: lowPrice,
            committed_peak_price,
            committed_low_price,
            committed_rtp,
            last_track_minute: null,
            last_commit_minute: null,
            prev_committed_rtp: undefined,
            rtp_met: false,
            rtp_met_tick: null,
            met: false,
            metTick: null
        };
    });

    const primaryCond = conditionsState[0] || {};
    const initialRtp = primaryCond.rtp || currentLtp;
    const initialMtp = primaryCond.mtp || null;

    addStrategyLog(
        strategyId,
        `[RE-ENTRY CONDITIONS] SL Hit for ${leg.instrument?.symbol || "leg"}. Setting state to WAITING_FOR_REENTRY_COND (${conditionsState.length} condition(s), reentry #${leg.reentry_count + 1}). Primary RTP: ₹${initialRtp}`,
        "INFO"
    );

    const newLeg = {
        leg: { ...leg.leg, reentry_conditions: rawConditions },
        instrument: { ...leg.instrument },
        orderId: null,
        uniqueOrderId: null,
        exitOrderId: null,
        state: "WAITING_FOR_REENTRY_COND",
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
        base_sl_price: slPrice,
        max_peak_price: (conditionsState.find(c => c.type === "RE_HIGH")?.max_peak_price) || null,
        max_low_price: (conditionsState.find(c => c.type === "RE_LOW")?.max_low_price) || null,
        slHitMinute: slHitMinute,
        reentry_conditions_state: conditionsState,
        reentry_conditions: rawConditions,
        rtp: initialRtp,
        mtp: initialMtp,
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
        exchangeSlProcessed: false,
        is_virtual_leg: config.is_virtual === true
    };

    strategy.legs.push(newLeg);
    return newLeg;
}

/**
 * Groups condition states by OR into AND-sequences, evaluating if overall logic is satisfied.
 */
function evaluateReentryConditionsGroup(conditionsState, currentTick) {
    if (!Array.isArray(conditionsState) || conditionsState.length === 0) {
        return { isSatisfied: false };
    }

    const groups = [];
    let currentGroup = [];

    for (let i = 0; i < conditionsState.length; i++) {
        const cond = conditionsState[i];
        if (i === 0) {
            currentGroup.push(cond);
        } else if (cond.operator === "AND") {
            currentGroup.push(cond);
        } else {
            // "OR"
            groups.push(currentGroup);
            currentGroup = [cond];
        }
    }
    if (currentGroup.length > 0) {
        groups.push(currentGroup);
    }

    for (const group of groups) {
        const allMet = group.every(c => c.met === true);
        if (allMet) {
            const triggeringCondition = group.find(c => c.metTick === currentTick) || group[group.length - 1];
            return {
                isSatisfied: true,
                triggeringGroup: group,
                triggeringCondition
            };
        }
    }

    return { isSatisfied: false };
}

/**
 * Processes a tick for legs in WAITING_FOR_REENTRY_COND.
 */
async function processReentryConditionsTick({
    leg,
    config,
    strategyId,
    addStrategyLog,
    tickPrice,
    prevTick,
    currentMinute,
    currentTime
}) {
    if (leg.state !== "WAITING_FOR_REENTRY_COND") return;
    if (leg.leg.no_reentry_on_sl_candle && leg.slHitMinute === currentMinute) return;

    const conditions = leg.reentry_conditions_state;
    if (!Array.isArray(conditions) || conditions.length === 0) return;

    const isSlCandle = (leg.slHitMinute === currentMinute);
    const candleOpen = leg.candleOpen ?? tickPrice;
    const currentSeconds = parseInt((currentTime || "").split(":")[2] || "0", 10);

    for (const cond of conditions) {
        if (cond.met) continue;

        const type = cond.type || "RE_COST";

        // If RTP was already met on a prior tick and momentum is enabled, check if MTP is reached
        if (cond.rtp_met) {
            if (cond.mntm_enabled && cond.mtp != null) {
                const targetMtp = cond.mtp;
                const baseRtp = cond.rtp_met_tick || cond.rtp;
                let mtpHit = false;
                if (targetMtp > baseRtp) {
                    if ((prevTick !== null && prevTick <= targetMtp && tickPrice >= targetMtp) || tickPrice >= targetMtp) {
                        mtpHit = true;
                    }
                } else if (targetMtp < baseRtp) {
                    if ((prevTick !== null && prevTick >= targetMtp && tickPrice <= targetMtp) || tickPrice <= targetMtp) {
                        mtpHit = true;
                    }
                } else {
                    mtpHit = true;
                }

                if (mtpHit) {
                    cond.met = true;
                    cond.metTick = tickPrice;
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] ${type} MTP met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (MTP: ₹${targetMtp}). Condition satisfied!`, "INFO");
                }
            } else {
                cond.met = true;
                cond.metTick = tickPrice;
            }
            continue;
        }

        if (type === "RE_COST") {
            const rtp = cond.rtp;
            const mode = cond.recost_mode || "RECOST_PLUS_PCT";
            let triggered = false;

            if (isSlCandle) {
                if (mode.includes("PLUS")) {
                    if (prevTick <= rtp && tickPrice >= rtp) triggered = true;
                } else {
                    if (prevTick >= rtp && tickPrice <= rtp) triggered = true;
                }
            } else {
                if (mode.includes("PLUS")) {
                    if (candleOpen > rtp) {
                        if (tickPrice <= rtp) triggered = true;
                    } else {
                        if (prevTick <= rtp && tickPrice >= rtp) triggered = true;
                    }
                } else {
                    if (candleOpen < rtp) {
                        if (tickPrice >= rtp) triggered = true;
                    } else {
                        if (prevTick >= rtp && tickPrice <= rtp) triggered = true;
                    }
                }
            }

            if (triggered) {
                cond.rtp_met = true;
                cond.rtp_met_tick = tickPrice;
                if (cond.mntm_enabled && cond.mtp != null) {
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_COST RTP met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (RTP: ₹${rtp}). Monitoring internally for MTP: ₹${cond.mtp}...`, "INFO");
                    const targetMtp = cond.mtp;
                    let mtpHit = false;
                    if (targetMtp > rtp) {
                        if (tickPrice >= targetMtp) mtpHit = true;
                    } else if (targetMtp < rtp) {
                        if (tickPrice <= targetMtp) mtpHit = true;
                    } else {
                        mtpHit = true;
                    }
                    if (mtpHit) {
                        cond.met = true;
                        cond.metTick = tickPrice;
                        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_COST MTP met on same tick for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (MTP: ₹${targetMtp}). Condition satisfied!`, "INFO");
                    }
                } else {
                    cond.met = true;
                    cond.metTick = tickPrice;
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_COST condition met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (RTP: ₹${rtp})`, "INFO");
                }
            }
        } else if (type === "RE_SL") {
            const rtp = cond.rtp;
            const mode = cond.resl_mode || "RESL_PLUS_PCT";
            let triggered = false;

            if (isSlCandle) {
                if (mode.includes("PLUS")) {
                    if (prevTick <= rtp && tickPrice >= rtp) triggered = true;
                } else {
                    if (prevTick >= rtp && tickPrice <= rtp) triggered = true;
                }
            } else {
                if (mode.includes("PLUS")) {
                    if (candleOpen > rtp) {
                        if (tickPrice <= rtp) triggered = true;
                    } else {
                        if (prevTick <= rtp && tickPrice >= rtp) triggered = true;
                    }
                } else {
                    if (candleOpen < rtp) {
                        if (tickPrice >= rtp) triggered = true;
                    } else {
                        if (prevTick >= rtp && tickPrice <= rtp) triggered = true;
                    }
                }
            }

            if (triggered) {
                cond.rtp_met = true;
                cond.rtp_met_tick = tickPrice;
                if (cond.mntm_enabled && cond.mtp != null) {
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_SL RTP met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (RTP: ₹${rtp}). Monitoring internally for MTP: ₹${cond.mtp}...`, "INFO");
                    const targetMtp = cond.mtp;
                    let mtpHit = false;
                    if (targetMtp > rtp) {
                        if (tickPrice >= targetMtp) mtpHit = true;
                    } else if (targetMtp < rtp) {
                        if (tickPrice <= targetMtp) mtpHit = true;
                    } else {
                        mtpHit = true;
                    }
                    if (mtpHit) {
                        cond.met = true;
                        cond.metTick = tickPrice;
                        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_SL MTP met on same tick for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (MTP: ₹${targetMtp}). Condition satisfied!`, "INFO");
                    }
                } else {
                    cond.met = true;
                    cond.metTick = tickPrice;
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] RE_SL condition met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (RTP: ₹${rtp})`, "INFO");
                }
            }
        } else if (type === "RE_HIGH" || type === "RE_LOW") {
            const isHigh = type === "RE_HIGH";
            const rtpOnClose = !!(isHigh ? cond.rehigh_rtp_on_close : cond.relow_rtp_on_close);
            const extremumLabel = isHigh ? "Peak" : "Low";
            const { extremum, checkRtp, commitAtClose } = updateExtremumTracker({
                tracker: cond,
                isHigh,
                rtpOnClose,
                mode: isHigh ? (cond.rehigh_mode || "REHIGH_MINUS_PTS") : (cond.relow_mode || "RELOW_PLUS_PTS"),
                val: isHigh ? cond.rehigh_value : cond.relow_value,
                tickPrice,
                currentMinute,
                currentSeconds,
                mntmEnabled: !!cond.mntm_enabled,
                mntmMode: cond.mntm_mode || "PLUS_PCT",
                mntmVal: cond.mntm_value || 0,
                isRtpMet: !!cond.rtp_met,
                syncLeg: isHigh ? (p) => { leg.max_peak_price = p; } : (l) => { leg.max_low_price = l; },
                addStrategyLog,
                strategyId,
                symbol: leg.instrument?.symbol || "leg",
                logNewExtremum: true
            });

            const isRtpTriggered = isSlCandle
                ? (isHigh ? tickPrice <= checkRtp : tickPrice >= checkRtp)
                : (isHigh
                    ? (candleOpen < checkRtp ? tickPrice >= checkRtp : tickPrice <= checkRtp)
                    : (candleOpen > checkRtp ? tickPrice <= checkRtp : tickPrice >= checkRtp));

            if (isRtpTriggered) {
                cond.rtp_met = true;
                cond.rtp_met_tick = tickPrice;
                if (cond.mntm_enabled && cond.mtp != null) {
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] ${type} RTP met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (${extremumLabel}: ₹${extremum}, RTP: ₹${checkRtp}). Monitoring internally for MTP: ₹${cond.mtp}...`, "INFO");
                    const targetMtp = cond.mtp;
                    const mtpHit = targetMtp > checkRtp
                        ? tickPrice >= targetMtp
                        : (targetMtp < checkRtp ? tickPrice <= targetMtp : true);
                    if (mtpHit) {
                        cond.met = true;
                        cond.metTick = tickPrice;
                        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] ${type} MTP met on same tick for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (MTP: ₹${targetMtp}). Condition satisfied!`, "INFO");
                    }
                } else {
                    cond.met = true;
                    cond.metTick = tickPrice;
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] ${type} condition met for ${leg.instrument?.symbol || "leg"} at ₹${tickPrice} (${extremumLabel}: ₹${extremum}, RTP: ₹${checkRtp})`, "INFO");
                }
            }

            commitAtClose(!cond.rtp_met);
        }
    }

    const primary = conditions[0];
    if (primary) {
        leg.rtp = primary.rtp;
        leg.mtp = primary.mtp;
    }

    const evalResult = evaluateReentryConditionsGroup(conditions, tickPrice);
    if (evalResult.isSatisfied && evalResult.triggeringCondition) {
        if (evalResult.triggeringGroup) {
            conditions.forEach(c => {
                const inGroup = evalResult.triggeringGroup.some(gc => gc.id === c.id);
                if (!inGroup) {
                    c.met = false;
                }
            });
        }
        await handleReentryConditionsTrigger({
            leg,
            config,
            strategyId,
            addStrategyLog,
            triggeringCondition: evalResult.triggeringCondition,
            triggeringGroup: evalResult.triggeringGroup,
            currentTick: tickPrice
        });
    }
}

/**
 * Places order and monitors fill when re-entry conditions are satisfied.
 */
async function handleReentryConditionsTrigger({
    leg,
    config,
    strategyId,
    addStrategyLog,
    triggeringCondition,
    triggeringGroup,
    currentTick
}) {
    const isVirtual = config?.is_virtual === true || leg.is_virtual_leg === true;
    const isPaperTrading = config?.is_paper_trading === true || isVirtual;

    if (config?.exit_time && isWithinSecondsOfExit(getISTTime(), config.exit_time, 5)) {
        addStrategyLog(strategyId, `Skipping Condition re-entry: within 5s of exit time (${config.exit_time})`, "INFO");
        return;
    }

    leg.reentry_count = (leg.reentry_count || 0) + 1;
    const rtp = triggeringCondition.rtp || currentTick;
    let targetPrice = triggeringCondition.mntm_enabled ? (triggeringCondition.mtp || rtp) : rtp;

    if (triggeringCondition.mntm_enabled) {
        leg.mtp = targetPrice;
        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] Momentum triggered for ${leg.instrument?.symbol || "leg"} (${triggeringCondition.type} | MTP: ₹${targetPrice} reached). Placing LIMIT order...`, "INFO");
    } else {
        leg.mtp = null;
        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] Condition triggered for ${leg.instrument?.symbol || "leg"} (${triggeringCondition.type} | RTP: ₹${rtp}). Placing LIMIT order...`, "INFO");
    }

    let variety = "NORMAL";
    let ordertype = config.ordertype || "LIMIT";
    const offsetAmt = isPaperTrading ? 0 : getLimitOffsetAmt(targetPrice, config);
    let finalPriceStr = targetPrice.toString();
    let triggerPriceStr = "0";
    const side = leg.leg.side;

    if (ordertype === "LIMIT") {
        if (side === "BUY") {
            finalPriceStr = roundToTick(targetPrice + offsetAmt).toString();
        } else {
            finalPriceStr = roundToTick(targetPrice - offsetAmt).toString();
        }
    } else {
        finalPriceStr = "0";
    }

    try {
        let reEntryOrder = await placeOrder(
            {
                ...config,
                side,
                variety,
                ordertype,
                price: finalPriceStr,
                triggerprice: triggerPriceStr,
                lots: leg.leg.lots
            },
            leg.instrument,
            config.connectionId
        );

        if (!reEntryOrder.uniqueorderid) {
            addStrategyLog(strategyId, `[ERROR] Angel One API returned a partial response for ${leg.instrument?.symbol}. Retrying entry...`, "ERROR");
            reEntryOrder = await placeOrder(
                {
                    ...config,
                    side,
                    variety,
                    ordertype,
                    price: finalPriceStr,
                    triggerprice: triggerPriceStr,
                    lots: leg.leg.lots
                },
                leg.instrument,
                config.connectionId
            );
        }

        leg.orderId = reEntryOrder.orderid;
        leg.uniqueOrderId = reEntryOrder.uniqueorderid;
        leg.state = "WAITING_FOR_FILL";
        leg.triggering_condition = triggeringCondition;
        leg.triggering_group = triggeringGroup;
        leg.rtp = rtp;
        leg.mtp = triggeringCondition.mntm_enabled ? targetPrice : null;
        if (Array.isArray(leg.reentry_conditions_state)) {
            leg.reentry_conditions_state.forEach(c => {
                const inGroup = Array.isArray(triggeringGroup) && triggeringGroup.some(gc => gc.id === c.id);
                if (inGroup || c.id === triggeringCondition.id || (triggeringCondition.type && c.type === triggeringCondition.type && c.rtp === triggeringCondition.rtp)) {
                    c.met = true;
                }
            });
        }

        addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] Order placed for ${leg.instrument?.symbol} at ₹${finalPriceStr} (${ordertype}).`, "INFO");

        if (leg.uniqueOrderId) {
            addStrategyLog(strategyId, `[Success] Angel one API returned a full response for ${leg.instrument?.symbol}.`, "INFO");
        } else {
            addStrategyLog(strategyId, `[CRITICAL] Retry failed: Angel One API returned a partial response again for ${leg.instrument?.symbol}.`, "ERROR");
            leg.state = "ERROR";
            return;
        }

        setTimeout(async () => {
            try {
                const { fillPrice, fillMeta, halted } = await resolveReentryOrderFill({
                    leg,
                    config,
                    strategyId,
                    side,
                    variety,
                    ordertype,
                    targetPrice,
                    priceStr: finalPriceStr,
                    triggerPriceStr: triggerPriceStr,
                    isPaperTrading,
                    isInstantFill: isPaperTrading,
                    isReentryChase: true,
                    timeoutMs: 28800000,
                    pollMs: 1000,
                    logPrefix: "[RE-ENTRY CONDITIONS]"
                });
                if (halted) return;

                if (fillPrice) {
                    const fill = fillPrice;
                    leg.entryPrice = fill;
                    leg.entryTime = fillMeta.time || getISTExchangeFormat();
                    leg.original_traded_price = leg.entryPrice;
                    leg.peakPrice = leg.entryPrice;
                    leg.tslReferencePrice = fill;
                    leg.state = "ACTIVE";
                    leg.triggering_condition = leg.triggering_condition || triggeringCondition;
                    leg.triggering_group = leg.triggering_group || triggeringGroup;
                    if (leg.leg && !leg.leg.reentry_conditions && leg.reentry_conditions) {
                        leg.leg.reentry_conditions = leg.reentry_conditions;
                    }
                    addStrategyLog(strategyId, `[RE-ENTRY CONDITIONS] Re-entry filled for ${leg.instrument?.symbol} at ₹${leg.entryPrice}.`, "INFO");

                    // Apply SL / TSL overrides to leg.leg
                    const cond = leg.triggering_condition || triggeringCondition;
                    if (cond) {
                        if (cond.reentry_sl_enabled) {
                            leg.leg.reentry_sl_enabled = true;
                            leg.leg.reentry_sl_type = cond.reentry_sl_type || "PERCENTAGE";
                            leg.leg.reentry_sl_value = parseFloat(cond.reentry_sl_value || 0);
                            leg.leg.reentry_sl_multiplier_entry_candle = !!cond.reentry_sl_multiplier_entry_candle;
                            leg.leg.reentry_sl_multiplier_value = cond.reentry_sl_multiplier_value;
                        } else {
                            leg.leg.reentry_sl_enabled = false;
                            leg.leg.reentry_sl_type = null;
                            leg.leg.reentry_sl_value = null;
                            leg.leg.reentry_sl_multiplier_entry_candle = false;
                            leg.leg.reentry_sl_multiplier_value = null;
                        }

                        if (cond.reentry_tsl_enabled) {
                            leg.leg.reentry_tsl_enabled = true;
                            leg.leg.reentry_tsl_type = cond.reentry_tsl_type || "PERCENTAGE";
                            leg.leg.reentry_tsl_move = parseFloat(cond.reentry_tsl_move || 0);
                            leg.leg.reentry_tsl_trail = parseFloat(cond.reentry_tsl_trail || 0);
                            leg.leg.reentry_tsl_on_close = !!cond.reentry_tsl_on_close;
                            leg.leg.reentry_tsl_on_close_low = !!cond.reentry_tsl_on_close_low;
                            leg.leg.reentry_tsl_on_close_high = !!cond.reentry_tsl_on_close_high;
                        } else {
                            leg.leg.reentry_tsl_enabled = false;
                            leg.leg.reentry_tsl_type = null;
                            leg.leg.reentry_tsl_move = null;
                            leg.leg.reentry_tsl_trail = null;
                            leg.leg.reentry_tsl_on_close = false;
                            leg.leg.reentry_tsl_on_close_low = false;
                            leg.leg.reentry_tsl_on_close_high = false;
                        }
                    }

                    // Redeploy SL if STOPLOSS variety
                    const isSlEnabled = leg.leg.reentry_sl_enabled ? true : leg.leg.sl_enabled !== false;
                    if (config.variety === "STOPLOSS" && leg.entryPrice && isSlEnabled) {
                        const activeSlType = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_type : (leg.leg.sl_type || "PERCENTAGE");
                        const activeSlValue = leg.leg.reentry_sl_enabled ? leg.leg.reentry_sl_value : leg.leg.stop_loss;

                        let slValueToUse = activeSlValue;
                        if (leg.leg.reentry_sl_multiplier_entry_candle && leg.leg.reentry_sl_multiplier_value) {
                            slValueToUse = activeSlValue * parseFloat(leg.leg.reentry_sl_multiplier_value);
                            leg.sl_multiplier_applied = true;
                        }

                        const slOrder = await placeStopLossWithRetry({
                            baseConfig: config,
                            legSide: leg.leg.side,
                            entryPrice: leg.entryPrice,
                            instrument: leg.instrument,
                            lots: leg.leg.lots,
                            slType: activeSlType,
                            slValue: slValueToUse,
                            slLimitMargin: config.entry_limit_offset,
                            slLimitMarginType: config.entry_limit_offset_type || "POINTS",
                            connectionId: config.connectionId,
                            strategyId: strategyId
                        });

                        const prices = computeStopLossExitPrices(
                            leg.entryPrice,
                            leg.leg.side,
                            activeSlType,
                            slValueToUse,
                            getLimitOffsetAmt(leg.entryPrice, config),
                            config.entry_limit_offset_type || "POINTS"
                        );
                        if (slOrder?.orderid) {
                            leg.slOrderId = slOrder.orderid;
                            leg.slUniqueOrderId = slOrder.uniqueorderid;
                        } else if (!slOrder?.deferred) {
                            addStrategyLog(strategyId, `[FALLBACK] Initializing virtual SL monitoring for ${leg.instrument?.symbol} (RE-COND Entry).`, "WARNING");
                        }
                        leg.slTriggerPrice = prices?.trigger;
                        leg.initialSlTriggerPrice = prices?.trigger;
                        leg.slLimitPrice = prices?.limit;
                        leg.exchangeSlProcessed = false;
                    }
                }
            } catch (e) {
                console.error("[RE-ENTRY CONDITIONS] Fill monitoring failed:", e.message);
            }
        }, 0);
    } catch (err) {
        await handleReentryPlacementError({
            err,
            strategyId,
            leg,
            targetPrice,
            side,
            logPrefix: "[RE-ENTRY CONDITIONS]"
        });
    }
}

module.exports = {
    initReentryConditionsLeg,
    evaluateReentryConditionsGroup,
    processReentryConditionsTick,
    handleReentryConditionsTrigger,
    calcExtremumRtp,
    calcConditionMtp,
    updateExtremumTracker
};

