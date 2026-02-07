const express = require("express");
const router = express.Router();
const strategyService = require("../services/strategy.service");

router.post("/save", async (req, res) => {
    try {
        const strategy = await strategyService.saveStrategy(req.body);
        res.json({ success: true, strategy });
    } catch (error) {
        console.error("Error saving strategy:", error.message);
        res.status(500).json({ success: false, message: "Failed to save strategy" });
    }
});

router.put("/update/:id", async (req, res) => {
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

router.post("/stop/:id", async (req, res) => {
    try {
        await strategyService.stopStrategy(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to stop strategy" });
    }
});

router.get("/user/:userId", async (req, res) => {
    try {
        const data = await strategyService.getUserStrategies(req.params.userId);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to fetch strategies" });
    }
});

router.get("/active/:userId", async (req, res) => {
    try {
        const active = strategyService.getActiveStrategy(req.params.userId);
        res.json({ success: true, data: active });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to fetch active strategy" });
    }
});

router.get("/status/:id", async (req, res) => {
    try {
        const status = strategyService.getStatus(req.params.id);
        if (!status) {
            return res.status(404).json({ success: false, message: "Strategy not found" });
        }
        res.json({ success: true, data: status });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to get strategy status" });
    }
});

module.exports = router;
