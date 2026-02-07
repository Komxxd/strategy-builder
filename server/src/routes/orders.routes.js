const express = require("express");
const router = express.Router();
const authMiddleware = require("../utils/authMiddleware");
const { getAuthorizedInstance } = require("../config/smartapi");

const ACTIONS = {
    placeOrder: "placeOrder",
    modifyOrder: "modifyOrder",
    cancelOrder: "cancelOrder",
    getOrderBook: "getOrderBook",
    getTradeBook: "getTradeBook",
    marketData: "marketData",
    indOrderDetails: "indOrderDetails"
};

router.post("/execute", authMiddleware, async (req, res) => {
    try {
        const { action, payload, connectionId } = req.body || {};

        if (!action || !ACTIONS[action]) {
            return res.status(400).json({
                success: false,
                message: "Invalid action. Use one of: " + Object.keys(ACTIONS).join(", ")
            });
        }

        const api = await getAuthorizedInstance(connectionId);
        const method = ACTIONS[action];

        if (typeof api[method] !== "function") {
            return res.status(400).json({
                success: false,
                message: `Action not supported by SmartAPI SDK: ${action}`
            });
        }

        let result;
        if (method === "indOrderDetails") {
            const qParam = typeof payload === "string"
                ? payload
                : payload?.uniqueorderid || payload?.uniqueOrderId || payload?.id;
            if (!qParam) {
                return res.status(400).json({
                    success: false,
                    message: "indOrderDetails requires uniqueorderid in payload or a string id."
                });
            }
            result = await api[method](qParam);
        } else {
            result = payload ? await api[method](payload) : await api[method]();
        }

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
