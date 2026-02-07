const express = require("express");
const router = express.Router();
const instrumentService = require("../services/instrument.service");

router.get("/search", (req, res) => {
    try {
        const { q, exchange, type } = req.query;

        const results = instrumentService.searchInstruments({
            query: q,
            exchange,
            type,
        });

        res.json({
            success: true,
            count: results.length,
            data: results,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err.message,
        });
    }
});

module.exports = router;
