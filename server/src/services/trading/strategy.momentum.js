const { roundToTick } = require("./strategy.offset");

/**
 * Calculates the Momentum Target price based on current LTP and configuration.
 */
function calculateMomentumTarget(instLtp, legConfig) {
    const mntmMode = legConfig.simple_mntm_mode || "SIMPLE_PLUS_PCT";
    const mntmVal = parseFloat(legConfig.simple_mntm_value || 0);
    let mntmTarget = instLtp;

    if (mntmMode === "SIMPLE_PLUS_PCT") mntmTarget = instLtp + (instLtp * mntmVal / 100);
    else if (mntmMode === "SIMPLE_PLUS_PTS") mntmTarget = instLtp + mntmVal;
    else if (mntmMode === "SIMPLE_MINUS_PCT") mntmTarget = instLtp - (instLtp * mntmVal / 100);
    else if (mntmMode === "SIMPLE_MINUS_PTS") mntmTarget = instLtp - mntmVal;

    return roundToTick(mntmTarget);
}

/**
 * Checks if a momentum target has been breached.
 * Returns true if the price has crossed the threshold.
 */
function checkMomentumHit(leg, currentTick, prevTick) {
    if (prevTick === null || prevTick === undefined) return false;
    
    const target = leg.mntmTargetPrice;
    const mode = leg.leg.simple_mntm_mode || "SIMPLE_PLUS_PCT";

    let mntmHit = false;
    if (mode.includes("PLUS")) {
        if (prevTick <= target && currentTick >= target) mntmHit = true;
    } else {
        if (prevTick >= target && currentTick <= target) mntmHit = true;
    }

    return mntmHit;
}

module.exports = {
    calculateMomentumTarget,
    checkMomentumHit
};
