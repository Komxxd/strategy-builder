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

const fs = require('fs');
const path = require('path');

router.get("/backtest-dates", async (req, res) => {
    try {
        const { index } = req.query; // 'NIFTY' or 'SENSEX'
        if (!index) return res.status(400).json({ success: false, message: "Index is required" });

        const indexDir = path.join(__dirname, "../../../market-data/index", index);
        if (!fs.existsSync(indexDir)) {
            return res.json({ success: true, data: [] });
        }

        const dates = new Set();

        const findDates = (dir) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    findDates(fullPath);
                } else if (file.endsWith('.parquet')) {
                    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.parquet$/);
                    if (match) {
                        dates.add(match[1]);
                    }
                }
            }
        };

        findDates(indexDir);
        const sortedDates = Array.from(dates).sort();
        res.json({ success: true, data: sortedDates });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
