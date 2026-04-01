const express = require("express");
const router = express.Router();
const socketService = require("../services/marketSocket.service");
const authService = require("../services/auth.service");

/**
 * GET /api/market-socket/status
 * Returns the live status of both the Angel One API session
 * and the WebSocket connection independently.
 */
router.get("/status", (req, res) => {
    const session = authService.getSession();
    res.json({
        success: true,
        apiConnected: !!session,
        socketConnected: socketService.isSocketConnected()
    });
});

/**
 * POST /api/market-socket/connect
 * Reconnects the WebSocket using the existing session (no re-login required).
 * Call this if the WebSocket drops but the Angel One session is still valid.
 */
router.post("/connect", (req, res) => {
    const session = authService.getSession();
    if (!session || !session.data) {
        return res.status(400).json({
            success: false,
            message: "No active Angel One session. Please login first."
        });
    }

    try {
        socketService.initMarketSocket({
            jwtToken: session.data.jwtToken,
            feedToken: session.data.feedToken,
            apiKey: process.env.SMARTAPI_API_KEY,
            clientCode: process.env.SMARTAPI_CLIENT_ID
        });
        res.json({ success: true, message: "WebSocket reconnecting..." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/market-socket/disconnect
 * Manually disconnects the WebSocket without logging out of Angel One.
 */
router.post("/disconnect", (req, res) => {
    socketService.disconnectMarketSocket();
    res.json({ success: true, message: "WebSocket disconnected." });
});

module.exports = router;

