const express = require("express");
const router = express.Router();
const authService = require("../services/auth.service");

// Tier 1 - Rule 1 & Phase 2: Zero-Knowledge Frontend
// This endpoint verifies the master password and returns the secret key
// so that the frontend doesn't need to have the key hardcoded or in VITE_ env.
router.post("/verify", (req, res) => {
    const { password } = req.body;
    const masterPassword = process.env.MASTER_PASSWORD;
    const apiKey = process.env.SECRET_API_KEY;

    if (password === masterPassword) {
        res.json({
            success: true,
            apiKey: apiKey,
            message: "Access granted"
        });
    } else {
        res.status(401).json({
            success: false,
            message: "Invalid password"
        });
    }
});

router.post("/login", async (req, res) => {
    try {
        const session = await authService.login();
        res.json({
            success: true,
            data: session,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

router.post("/logout", (req, res) => {
    authService.logout();
    res.json({ success: true, message: "Logged out successfully" });
});

module.exports = router;

