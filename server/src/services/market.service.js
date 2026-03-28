const { getAuthorizedInstance } = require("../config/smartapi");
const redis = require("../config/redis");

// Helper to prevent dangling promises if AngelOne doesn't close sockets
const withTimeout = (promise, ms = 8000) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Angel One API timed out after ${ms}ms`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
};

async function getLTP({ exchange, symboltoken, connectionId }) {
    const api = await getAuthorizedInstance(connectionId);
    const tokens = Array.isArray(symboltoken) ? symboltoken : [symboltoken];
    return await withTimeout(api.marketData({
        mode: "LTP",
        exchangeTokens: {
            [exchange]: tokens,
        },
    }));
}

async function getHistoricalData({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    try {
        const cacheKey = `candles:${exchange}:${symboltoken}:${interval}:${fromdate}:${todate}`;
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (e) { /* Redis error, fallback to API */ }

        const api = await getAuthorizedInstance(connectionId);
        const data = await withTimeout(api.getCandleData({
            exchange,
            symboltoken,
            interval,
            fromdate,
            todate,
        }));

        if (data && data.status) {
            try {
                await redis.setex(cacheKey, 86400, JSON.stringify(data)); // Cache for 24h
            } catch (e) { /* Ignore */ }
        }

        return data;
    } catch (error) {
        console.error("SmartAPI getCandleData error:", error);
        throw error;
    }
}

module.exports = {
    getLTP,
    getHistoricalData,
};
