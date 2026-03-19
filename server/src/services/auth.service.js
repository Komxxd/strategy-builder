const { defaultSmartApi, getAuthorizedInstance, registerAuthErrorCallback } = require("../config/smartapi");
const speakeasy = require("speakeasy");
const marketSocketService = require("./marketSocket.service");

let sessionData = null;

async function login() {
    if (!process.env.SMARTAPI_TOTP_SECRET || !process.env.SMARTAPI_CLIENT_ID || !process.env.SMARTAPI_PASSWORD) {
        throw new Error("Missing SmartAPI environment variables");
    }

    const totp = speakeasy.totp({
        secret: process.env.SMARTAPI_TOTP_SECRET,
        encoding: 'base32'
    });

    sessionData = await defaultSmartApi.generateSession(
        process.env.SMARTAPI_CLIENT_ID,
        process.env.SMARTAPI_PASSWORD,
        totp
    );

    if (sessionData && sessionData.status) {
        // We don't need to manually set access token on defaultSmartApi if generateSession handles it,
        // but smartapi-javascript usually requires it for subsequent calls.
        defaultSmartApi.setAccessToken(sessionData.data.jwtToken);

        marketSocketService.initMarketSocket({
            jwtToken: sessionData.data.jwtToken,
            feedToken: sessionData.data.feedToken,
            apiKey: process.env.SMARTAPI_API_KEY,
            clientCode: process.env.SMARTAPI_CLIENT_ID
        }, () => {
            console.log("Initializing active strategies from DB post-login...");
            const strategyService = require("./strategy.service");
            strategyService.initializeActiveStrategies();
        });

        console.log("Logged in successfully to SmartAPI");
    } else {
        throw new Error("Login failed: " + (sessionData ? sessionData.message : "No session data"));
    }

    return sessionData;
}

function getSession() {
    if (sessionData && marketSocketService.isSocketConnected && marketSocketService.isSocketConnected()) {
        return sessionData;
    }
    return null;
}

function logout() {
    sessionData = null;
    marketSocketService.disconnectMarketSocket();
    console.log("Logged out from SmartAPI");
}

module.exports = {
    login,
    getSession,
    logout,
};

registerAuthErrorCallback(() => {
    console.warn("Global token expiry totally intercepted! Automatically logging out...");
    logout();
});
