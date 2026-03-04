const express = require("express");
const router = express.Router();
const socketService = require("../services/marketSocket.service");

// WebSocket subscription for LTP is removed in favor of Global Price Fetcher (polling).
// This file is kept for future socket-related routes (e.g. status pings).

module.exports = router;
