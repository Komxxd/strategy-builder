const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
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

/**
 * Strict rate limiter for the Angel One login endpoint.
 *
 * The outer authLimiter in app.js (20 req / 15 min) is intentionally loose
 * because it also covers /verify and /logout which are low-risk.
 *
 * /login is different — it calls Angel One's external API with a TOTP code.
 * Angel One may lock the account after ~5 failed login attempts.
 * 3 requests per minute is enough for any legitimate use case
 * (you only ever click login once) while blocking brute-force attacks.
 */
const loginLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute window
    max: 3,               // 3 attempts per minute max
    message: {
        success: false,
        message: "Too many login attempts. Please wait 1 minute before trying again."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post("/login", loginLimiter, async (req, res) => {
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

router.get("/status", (req, res) => {
    const session = authService.getSession();
    res.json({
        success: true,
        connected: !!session
    });
});

module.exports = router;
