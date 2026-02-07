const express = require("express");
const router = express.Router();
const authService = require("../services/auth.service");
const authMiddleware = require("../utils/authMiddleware");

router.post("/login", authMiddleware, async (req, res) => {
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

module.exports = router;
