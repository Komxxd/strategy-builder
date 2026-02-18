const { getAuthorizedInstance } = require("../config/smartapi");

async function getLTP({ exchange, symboltoken, connectionId }) {
    const api = await getAuthorizedInstance(connectionId);
    const tokens = Array.isArray(symboltoken) ? symboltoken : [symboltoken];
    return await api.marketData({
        mode: "LTP",
        exchangeTokens: {
            [exchange]: tokens,
        },
    });
}

async function getHistoricalData({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    try {
        const api = await getAuthorizedInstance(connectionId);
        return await api.getCandleData({
            exchange,
            symboltoken,
            interval,
            fromdate,
            todate,
        });
    } catch (error) {
        console.error("SmartAPI getCandleData error:", error);
        throw error;
    }
}

module.exports = {
    getLTP,
    getHistoricalData,
};
