const express = require("express");
const router = express.Router();
const authService = require("../services/auth.service");

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

module.exports = router;
