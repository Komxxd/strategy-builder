const express = require("express");
const router = express.Router();
const socketService = require("../services/marketSocket.service");
const authService = require("../services/auth.service");

/**
 * GET /api/market-socket/status
 * Returns the live status of the Angel One API session and the global WebSocket connection.
 */
router.get("/status", (req, res) => {
    // Check if the master server is connected to Angel One WebSocket
    const socketConnected = socketService.isSocketConnected();
    
    // Check if the master server has a valid session
    const session = authService.getSession();
    const apiConnected = !!(session && session.data && session.data.jwtToken);

    res.json({
        success: true,
        apiConnected: apiConnected,
        socketConnected: socketConnected
    });
});

/**
 * POST /api/market-socket/connect
 * Uses credentials from .env to generate a session (with feedToken) and connect the global WebSocket.
 */
router.post("/connect", async (req, res) => {
    try {
        await authService.login();
        res.json({ success: true, message: "Global Master WebSocket connecting to Live Data..." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/market-socket/disconnect
 * Manually disconnects the global WebSocket without logging out of Angel One.
 */
router.post("/disconnect", (req, res) => {
    socketService.disconnectMarketSocket();
    res.json({ success: true, message: "WebSocket disconnected." });
});

module.exports = router;

