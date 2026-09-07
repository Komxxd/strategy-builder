const express = require("express");
const router = express.Router();
const settingsService = require("../services/settings.service");

router.get("/", async (req, res) => {
    try {
        const userId = req.user.id;
        const data = await settingsService.getSettings(userId);
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error fetching user settings:", error);
        res.status(500).json({ success: false, message: "Failed to fetch settings", details: error.message });
    }
});

router.post("/", async (req, res) => {
    try {
        const userId = req.user.id;
        const data = await settingsService.updateSettings(userId, req.body);
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error updating user settings:", error);
        res.status(500).json({ success: false, message: "Failed to update settings", details: error.message });
    }
});

module.exports = router;
