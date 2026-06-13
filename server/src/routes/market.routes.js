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

const redis = require('../config/redis');

router.get("/backtest-dates", async (req, res) => {
    try {
        const { index } = req.query; // 'NIFTY' or 'SENSEX'
        if (!index) return res.status(400).json({ success: false, message: "Index is required" });

        // Ensure Redis is connected before trying to get data, otherwise it throws Stream not writeable due to lazyConnect
        if (redis.status !== 'ready') {
            if (redis.status === 'wait') {
                redis.connect().catch(() => {});
            }
            // Wait up to 1 second for it to be ready
            await new Promise((resolve) => {
                const timeout = setTimeout(resolve, 1000);
                redis.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }

        // First try to get it from Redis (this is populated by the Backtest Server)
        if (redis.status === 'ready') {
            const cachedDates = await redis.get(`backtest:dates:${index}`);
            if (cachedDates) {
                return res.json({ success: true, data: JSON.parse(cachedDates) });
            }
        }

        // Fallback: If not in Redis, try the local file system (useful for local development without the worker)
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
