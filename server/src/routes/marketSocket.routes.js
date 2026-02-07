const express = require("express");
const router = express.Router();
const socketService = require("../services/marketSocket.service");

router.post("/subscribe", (req, res) => {
    try {
        const { exchangeType, tokens } = req.body;

        socketService.subscribeTokens({ exchangeType, tokens });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
