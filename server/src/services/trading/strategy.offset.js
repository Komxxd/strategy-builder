function roundToTick(price, tick = 0.05) {
    if (price === null || price === undefined || isNaN(price)) return 0;
    return Number(Math.max(tick, Math.round(price / tick) * tick).toFixed(2));
}

function getLimitOffsetAmt(basePrice, config) {
    const val = parseFloat(config.entry_limit_offset || 0);
    if (!basePrice || val <= 0) return val;
    if (config.entry_limit_offset_type === 'PERCENTAGE') {
        return basePrice * (val / 100);
    }
    return val;
}

function computeStopLossExitPrices(entryPrice, side, slType, slValue, limitMargin, marginType = 'POINTS') {
    const val = Number(slValue || 0);
    const rawMargin = Number(limitMargin || 0);
    if (!entryPrice || val <= 0) return null;

    let trigger;
    if (slType === "POINTS") {
        trigger = side === "BUY"
            ? entryPrice - val
            : entryPrice + val;
    } else {
        // Default to PERCENTAGE
        trigger = side === "BUY"
            ? entryPrice * (1 - val / 100)
            : entryPrice * (1 + val / 100);
    }

    const margin = marginType === 'PERCENTAGE' ? (trigger * (rawMargin / 100)) : rawMargin;

    const limit = side === "BUY"
        ? trigger - margin
        : trigger + margin;

    return {
        trigger: roundToTick(trigger),
        limit: roundToTick(limit)
    };
}

function resolveUniversalOrderParams({ targetPrice, currentLtp, side, offset }) {
    let variety = "NORMAL";
    let ordertype = "LIMIT";
    let price = targetPrice;
    let triggerprice = "0";

    const roundedTarget = roundToTick(targetPrice);
    const roundedLtp = roundToTick(currentLtp);

    if (side === "SELL") {
        if (roundedTarget < roundedLtp) {
            // Sell BELOW current LTP -> Stop Loss Limit (Breakout Down)
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            triggerprice = roundedTarget.toString();
            price = roundToTick(roundedTarget - offset).toString();
        } else {
            // Sell ABOVE current LTP -> Regular Limit (Retracement Up)
            variety = "NORMAL";
            ordertype = "LIMIT";
            price = roundToTick(roundedTarget - offset).toString();
        }
    } else {
        // side === "BUY"
        if (roundedTarget > roundedLtp) {
            // Buy ABOVE current LTP -> Stop Loss Limit (Breakout Up)
            variety = "STOPLOSS";
            ordertype = "STOPLOSS_LIMIT";
            triggerprice = roundedTarget.toString();
            price = roundToTick(roundedTarget + offset).toString();
        } else {
            // Buy BELOW current LTP -> Regular Limit (Retracement Down)
            variety = "NORMAL";
            ordertype = "LIMIT";
            price = roundToTick(roundedTarget + offset).toString();
        }
    }

    return { variety, ordertype, price, triggerprice };
}

module.exports = {
    roundToTick,
    getLimitOffsetAmt,
    computeStopLossExitPrices,
    resolveUniversalOrderParams
};
