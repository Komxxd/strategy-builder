const { getAuthorizedInstance } = require("../config/smartapi");

async function getLTP({ exchange, symboltoken, connectionId }) {
    const api = await getAuthorizedInstance(connectionId);
    return await api.marketData({
        mode: "LTP",
        exchangeTokens: {
            [exchange]: [symboltoken],
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
