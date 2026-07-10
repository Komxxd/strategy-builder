const express = require("express");
const router = express.Router();
const socketService = require("../services/marketSocket.service");
const authService = require("../services/auth.service");

/**
 * GET /api/market-socket/status
 * Returns the live status of both the Angel One API session
 * and the WebSocket connection independently.
 */
const sessionService = require("../services/session.service");
const workerSocketService = require("../services/workerSocket.service");

/**
 * GET /api/market-socket/status
 * Returns the live status of the Angel One API session and the Worker WebSocket connection.
 */
router.get("/status", (req, res) => {
    const userId = req.user.id;
    const userSession = sessionService.getSession(userId);
    const apiConnected = !!(userSession && userSession.jwtToken);
    
    // Check if this specific user has an active worker node connected
    const socketConnected = workerSocketService.hasWorkerConnected(userId);

    res.json({
        success: true,
        apiConnected: apiConnected,
        socketConnected: socketConnected
    });
});

/**
 * POST /api/market-socket/connect
 * Tells the user's Worker Node to subscribe to the Top Bar UI tokens (NIFTY/BANKNIFTY).
 */
router.post("/connect", (req, res) => {
    const userId = req.user.id;
    const session = sessionService.getSession(userId);
    
    if (!session || !session.jwtToken) {
        return res.status(400).json({
            success: false,
            message: "No active Angel One session. Please login first."
        });
    }

    if (!workerSocketService.hasWorkerConnected(userId)) {
        return res.status(400).json({
            success: false,
            message: "No active Dedicated Virtual Environment. Please allocate one in Broker Setup."
        });
    }

    try {
        res.json({ success: true, message: "Worker Node is active! Live Data will stream automatically when a strategy starts." });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/market-socket/disconnect
 * Ignored in the new architecture since WebSockets are autonomous on the Worker Node.
 */
router.post("/disconnect", (req, res) => {
    res.json({ success: true, message: "Global disconnect ignored (Autonomous worker handles lifecycle)." });
});

module.exports = router;

