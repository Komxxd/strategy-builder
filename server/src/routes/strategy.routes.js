const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const strategyService = require("../services/strategy.service");

// Tier 2 - Rule 8: Basic input validation
const validateStrategy = [
    body("name").trim().notEmpty().withMessage("Strategy name is required").isLength({ max: 100 }),
    body("index").isIn(["NIFTY", "SENSEX"]).withMessage("Invalid index selection"),
    body("legs").isArray({ min: 1 }).withMessage("At least one leg is required"),
    body("legs.*.option_type").isIn(["CE", "PE"]).withMessage("Invalid option type"),
    body("legs.*.side").isIn(["BUY", "SELL"]).withMessage("Invalid side"),
    body("legs.*.lots").isInt({ min: 1 }).withMessage("Lots must be a positive integer"),
    body("variety").equals("STOPLOSS").withMessage("Invalid variety"),
    body("producttype").equals("CARRYFORWARD").withMessage("Invalid product type"),
    body("ordertype").equals("LIMIT").withMessage("Invalid order type"),
    body("duration").equals("DAY").withMessage("Invalid duration"),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.error("Validation failed for strategy operation:", JSON.stringify(errors.array(), null, 2));
            return res.status(400).json({ success: false, errors: errors.array() });
        }
        next();
    }
];

router.post("/save", validateStrategy, async (req, res) => {
    try {
        const userId = req.user.id;
        const strategy = await strategyService.saveStrategy(req.body, userId);
        res.json({ success: true, strategy });
    } catch (error) {
        console.error("Error saving strategy:", error.message);
        res.status(500).json({ success: false, message: "Failed to save strategy" });
    }
});

router.put("/update/:id", validateStrategy, async (req, res) => {
    try {
        const userId = req.user.id;
        const strategy = await strategyService.updateStrategy(req.params.id, req.body, userId);
        res.json({ success: true, data: strategy });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || "Failed to update strategy" });
    }
});

// Safe partial update for execution settings (quantity_multiplier, etc.)
// No validateStrategy middleware — we only merge specific fields into the existing config.
router.patch("/settings/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        const strategy = await strategyService.patchExecutionSettings(req.params.id, req.body, userId);
        res.json({ success: true, data: strategy });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || "Failed to update execution settings" });
    }
});


router.delete("/delete/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.deleteStrategy(req.params.id, userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || "Failed to delete strategy" });
    }
});

router.post("/execute/:id", async (req, res) => {
    try {
        const { is_paper_trading, is_virtual, mode } = req.body;
        const userId = req.user.id;
        const strategyId = await strategyService.startStrategy(req.params.id, { is_paper_trading, is_virtual, mode }, userId);
        res.json({ success: true, strategy_id: strategyId });
    } catch (error) {
        console.error("Error starting strategy:", error.message);
        res.status(500).json({ success: false, message: "Failed to start strategy" });
    }
});

router.post("/squareoff/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.squareOffStrategy(req.params.id, userId);
        res.json({ success: true, message: "Strategy Squared Off" });
    } catch (error) {
        console.error("Error squaring off strategy:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to square off strategy" });
    }
});

router.post("/squareoff/:id/leg/:legIndex", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.squareOffLeg(req.params.id, parseInt(req.params.legIndex), userId);
        res.json({ success: true, message: "Leg Squared Off" });
    } catch (error) {
        console.error("Error squaring off leg:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to square off leg" });
    }
});

router.post("/stop/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.stopStrategy(req.params.id, userId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to stop strategy" });
    }
});

router.post("/movetohistory/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.forceMoveToHistory(req.params.id, userId);
        res.json({ success: true, message: "Strategy moved to history" });
    } catch (error) {
        console.error("Error moving strategy to history:", error.message);
        res.status(500).json({ success: false, message: "Failed to move strategy to history" });
    }
});

router.post("/resume/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        await strategyService.resumeStrategy(req.params.id, userId);
        res.json({ success: true, message: "Strategy Resumed" });
    } catch (error) {
        console.error("Error resuming strategy:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to resume strategy" });
    }
});

router.post("/switch-virtual/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        const { is_virtual } = req.body;
        await strategyService.switchVirtualMode(req.params.id, is_virtual === true || is_virtual === "true", userId);
        res.json({ success: true, message: `Strategy switched to ${is_virtual ? 'Virtual' : 'Active'} mode` });
    } catch (error) {
        console.error("Error switching strategy virtual mode:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to switch virtual mode" });
    }
});


router.get("/user", async (req, res) => {
    try {
        const userId = req.user.id;
        const data = await strategyService.getUserStrategies(userId);
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error fetching user strategies:", error);
        res.status(500).json({ success: false, message: "Failed to fetch strategies", details: error.message });
    }
});

router.get("/active", async (req, res) => {
    try {
        const userId = req.user.id;
        const active = await strategyService.getActiveStrategies(userId);
        res.json({ success: true, data: active });
    } catch (error) {
        console.error("Error fetching active strategies:", error);
        res.status(500).json({ success: false, message: "Failed to fetch active strategies", details: error.message });
    }
});

router.get("/history", async (req, res) => {
    try {
        const userId = req.user.id;
        const history = await strategyService.getExecutionHistory(userId);
        res.json({ success: true, data: history });
    } catch (error) {
        console.error("Error fetching execution history:", error);
        res.status(500).json({ success: false, message: "Failed to fetch strategy history", details: error.message });
    }
});

router.get("/status/:id", async (req, res) => {
    try {
        const userId = req.user.id;
        const status = await strategyService.getStatus(req.params.id, userId);
        if (!status) {
            return res.status(404).json({ success: false, message: "Strategy not found" });
        }
        res.json({ success: true, data: status });
    } catch (error) {
        console.error("Error fetching strategy status:", error);
        res.status(500).json({ success: false, message: "Failed to get strategy status", details: error.message });
    }
});

const { addBacktestJob, backtestQueue } = require('../queue/backtestQueue');

router.post("/backtest", async (req, res) => {
    try {
        const userId = req.user.id;
        const { strategyId, fromDate, toDate } = req.body;
        if (!strategyId || !fromDate || !toDate) {
            return res.status(400).json({ success: false, message: "strategyId, fromDate, toDate required" });
        }

        const jobId = await addBacktestJob({ strategyId, fromDate, toDate, userId });
        res.json({ success: true, jobId, message: "Backtest started" });
    } catch (error) {
        console.error("Error queueing backtest:", error);
        res.status(500).json({ success: false, message: "Failed to queue backtest", details: error.message });
    }
});

router.post("/backtest/combined", async (req, res) => {
    try {
        const userId = req.user.id;
        const { strategyIds, fromDate, toDate } = req.body;
        if (!strategyIds || !Array.isArray(strategyIds) || !fromDate || !toDate) {
            return res.status(400).json({ success: false, message: "strategyIds array, fromDate, toDate required" });
        }

        const jobId = await addBacktestJob({ strategyIds, fromDate, toDate, userId });
        res.json({ success: true, jobId, message: "Combined backtest started" });
    } catch (error) {
        console.error("Error queueing combined backtest:", error);
        res.status(500).json({ success: false, message: "Failed to queue combined backtest", details: error.message });
    }
});

router.get("/backtest/status/:jobId", async (req, res) => {
    try {
        const job = await backtestQueue.getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: "Job not found" });
        }

        const isCompleted = await job.isCompleted();
        const isFailed = await job.isFailed();

        if (isCompleted) {
            return res.json({ success: true, status: 'completed', data: job.returnvalue });
        } else if (isFailed) {
            return res.json({ success: false, status: 'failed', message: job.failedReason });
        } else {
            return res.json({ success: true, status: 'active' });
        }
    } catch (error) {
        console.error("Error getting backtest status:", error);
        res.status(500).json({ success: false, message: "Failed to get backtest status", details: error.message });
    }
});

module.exports = router;
