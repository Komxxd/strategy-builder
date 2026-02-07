const express = require("express");
const router = express.Router();
const marketService = require("../services/market.service");

router.post("/ltp", async (req, res) => {
    try {
        const { exchange, tradingsymbol, symboltoken } = req.body;

        if (!exchange || !tradingsymbol || !symboltoken) {
            return res.status(400).json({
                success: false,
                message: "exchange, tradingsymbol, symboltoken required",
            });
        }

        const ltp = await marketService.getLTP({
            exchange,
            tradingsymbol,
            symboltoken
        });

        res.json({ success: true, data: ltp });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/candles", async (req, res) => {
    try {
        const { exchange, symboltoken, interval, fromdate, todate } = req.body;

        if (!exchange || !symboltoken || !interval || !fromdate || !todate) {
            return res.status(400).json({
                success: false,
                message: "exchange, symboltoken, interval, fromdate, todate are required",
            });
        }

        const candles = await marketService.getHistoricalData({
            exchange,
            symboltoken,
            interval,
            fromdate,
            todate
        });

        res.json({ success: true, data: candles });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
