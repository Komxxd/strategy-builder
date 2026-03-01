const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const strategyService = require("../services/strategy.service");

// Tier 2 - Rule 8: Basic input validation
const validateStrategy = [
    body("name").trim().notEmpty().withMessage("Strategy name is required").isLength({ max: 100 }),
    body("index").isIn(["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"]).withMessage("Invalid index selection"),
    body("legs").isArray({ min: 1 }).withMessage("At least one leg is required"),
    body("legs.*.option_type").isIn(["CE", "PE"]).withMessage("Invalid option type"),
    body("legs.*.side").isIn(["BUY", "SELL"]).withMessage("Invalid side"),
    body("legs.*.lots").isInt({ min: 1 }).withMessage("Lots must be a positive integer"),
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }
        next();
    }
];

router.post("/save", validateStrategy, async (req, res) => {
    try {
        const strategy = await strategyService.saveStrategy(req.body);
        res.json({ success: true, strategy });
    } catch (error) {
        console.error("Error saving strategy:", error.message);
        res.status(500).json({ success: false, message: "Failed to save strategy" });
    }
});

router.put("/update/:id", validateStrategy, async (req, res) => {
    try {
        const strategy = await strategyService.updateStrategy(req.params.id, req.body);
        res.json({ success: true, data: strategy });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || "Failed to update strategy" });
    }
});


router.delete("/delete/:id", async (req, res) => {
    try {
        await strategyService.deleteStrategy(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || "Failed to delete strategy" });
    }
});

router.post("/execute/:id", async (req, res) => {
    try {
        const strategyId = await strategyService.startStrategy(req.params.id);
        res.json({ success: true, strategy_id: strategyId });
    } catch (error) {
        console.error("Error starting strategy:", error.message);
        res.status(500).json({ success: false, message: "Failed to start strategy" });
    }
});

router.post("/squareoff/:id", async (req, res) => {
    try {
        await strategyService.squareOffStrategy(req.params.id);
        res.json({ success: true, message: "Strategy Squared Off" });
    } catch (error) {
        console.error("Error squaring off strategy:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to square off strategy" });
    }
});

router.post("/squareoff/:id/leg/:legIndex", async (req, res) => {
    try {
        await strategyService.squareOffLeg(req.params.id, parseInt(req.params.legIndex));
        res.json({ success: true, message: "Leg Squared Off" });
    } catch (error) {
        console.error("Error squaring off leg:", error.message);
        res.status(500).json({ success: false, message: error.message || "Failed to square off leg" });
    }
});

router.post("/stop/:id", async (req, res) => {
    try {
        await strategyService.stopStrategy(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to stop strategy" });
    }
});

router.get("/user", async (req, res) => {
    try {
        const data = await strategyService.getUserStrategies();
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error fetching user strategies:", error);
        res.status(500).json({ success: false, message: "Failed to fetch strategies", details: error.message });
    }
});

router.get("/active", async (req, res) => {
    try {
        const active = await strategyService.getActiveStrategies();
        res.json({ success: true, data: active });
    } catch (error) {
        console.error("Error fetching active strategies:", error);
        res.status(500).json({ success: false, message: "Failed to fetch active strategies", details: error.message });
    }
});

router.get("/history", async (req, res) => {
    try {
        const history = await strategyService.getExecutionHistory();
        res.json({ success: true, data: history });
    } catch (error) {
        console.error("Error fetching execution history:", error);
        res.status(500).json({ success: false, message: "Failed to fetch strategy history", details: error.message });
    }
});

router.get("/status/:id", async (req, res) => {
    try {
        const status = await strategyService.getStatus(req.params.id);
        if (!status) {
            return res.status(404).json({ success: false, message: "Strategy not found" });
        }
        res.json({ success: true, data: status });
    } catch (error) {
        console.error("Error fetching strategy status:", error);
        res.status(500).json({ success: false, message: "Failed to get strategy status", details: error.message });
    }
});

module.exports = router;
