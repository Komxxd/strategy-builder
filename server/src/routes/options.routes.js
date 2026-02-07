const express = require("express");
const router = express.Router();
const optionChainService = require("../services/optionChain.service");

router.get("/chain", (req, res) => {
    try {
        const { symbol, exchange, expiry } = req.query;

        if (!symbol || !exchange) {
            return res.status(400).json({
                success: false,
                message: "symbol and exchange are required",
            });
        }

        const chain = optionChainService.getOptionChain({
            symbol: symbol.toUpperCase(),
            exchange,
            expiry,
        });

        if (!chain) {
            return res.status(404).json({
                success: false,
                message: "No option chain found",
            });
        }

        res.json({
            success: true,
            data: chain,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

module.exports = router;
