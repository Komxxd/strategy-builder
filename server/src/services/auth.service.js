const { defaultSmartApi, getAuthorizedInstance, registerAuthErrorCallback } = require("../config/smartapi");
const speakeasy = require("speakeasy");
const marketSocketService = require("./marketSocket.service");

let sessionData = null;
let isLoggingIn = false; // Guard against double-login race condition

async function login() {
    // If already logged in (e.g., a second device opens the app while someone
    // else already logged in), just return the existing session silently.
    // No need to re-authenticate — the session is shared server-wide.
    // The frontend will get broker_status: true from Socket.io on connection
    // anyway, but this handles the edge case where someone manually clicks login.
    if (sessionData) {
        console.log("[Auth] Login called but already logged in. Returning existing session.");
        return sessionData;
    }

    // Prevent two concurrent login requests racing each other
    // (e.g., rapid double-click before the first request completes)
    if (isLoggingIn) {
        throw new Error("Login already in progress. Please wait.");
    }

    if (!process.env.SMARTAPI_TOTP_SECRET || !process.env.SMARTAPI_CLIENT_ID || !process.env.SMARTAPI_PASSWORD) {
        throw new Error("Missing SmartAPI environment variables");
    }

    isLoggingIn = true;

    try {
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
            defaultSmartApi.setAccessToken(sessionData.data.jwtToken);

            // Write the session into the NodeCache so getAuthorizedInstance(connectionId)
            // can look it up correctly. Without this, the cache is always empty and
            // every call falls back to defaultSmartApi regardless of connectionId.
            const sessionService = require("./session.service");
            sessionService.setSession(process.env.SMARTAPI_CLIENT_ID, {
                jwtToken: sessionData.data.jwtToken,
                feedToken: sessionData.data.feedToken,
                api_key: process.env.SMARTAPI_API_KEY
            });

            marketSocketService.initMarketSocket({
                jwtToken: sessionData.data.jwtToken,
                feedToken: sessionData.data.feedToken,
                apiKey: process.env.SMARTAPI_API_KEY,
                clientCode: process.env.SMARTAPI_CLIENT_ID
            }, () => {
                // onConnected: restore any active strategies from DB
                const strategyService = require("./strategy.service");
                strategyService.initializeActiveStrategies();
            });

            // Notify frontend that the Angel One session is now live
            marketSocketService.emitApiStatus(true);
            console.log("Logged in successfully to SmartAPI");
        } else {
            // Capture the error message BEFORE clearing sessionData —
            // otherwise the ternary below always evaluates the null branch.
            const failureMessage = sessionData?.message || "No session data returned by Angel One";
            sessionData = null;
            throw new Error("Login failed: " + failureMessage);
        }
    } finally {
        isLoggingIn = false;
    }

    return sessionData;
}

function getSession() {
    // Returns the session if Angel One login is active.
    // WebSocket connection state is intentionally NOT checked here —
    // the session and the WebSocket are independent. You can be logged in
    // to Angel One but have the WebSocket disconnected (e.g., manually stopped).
    return sessionData || null;
}

function logout() {
    // Clear the NodeCache entry so getAuthorizedInstance() can't use a stale session
    const sessionService = require("./session.service");
    sessionService.deleteSession(process.env.SMARTAPI_CLIENT_ID);

    sessionData = null;
    marketSocketService.disconnectMarketSocket(); // emits socket_status: false

    // Bug 3 fix: Also tell the frontend the Angel One session is gone.
    // Without this, the Angel One pill stays green after a token expiry
    // because only socket_status: false is emitted by disconnectMarketSocket.
    marketSocketService.emitApiStatus(false);

    console.log("Logged out from SmartAPI");
}

module.exports = {
    login,
    getSession,
    logout,
};

registerAuthErrorCallback(() => {
    console.warn("[Auth] Token expiry intercepted. Forcing global logout and notifying frontend...");
    logout();
});
