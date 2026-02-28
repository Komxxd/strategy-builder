const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const marketRoutes = require("./routes/market.routes");
const marketSocketRoutes = require("./routes/marketSocket.routes");
const strategyRoutes = require("./routes/strategy.routes");
const authMiddleware = require("./utils/authMiddleware");

const app = express();

const frontendUrls = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ["http://localhost:5173", "http://localhost:5174"];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || frontendUrls.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));
app.use(express.json());

app.use("/api/auth", authRoutes); // Auth route allows getting initialized sessions seamlessly

// Apply API Key security to the protected endpoints
app.use("/api/market", authMiddleware, marketRoutes);
app.use("/api/market-socket", authMiddleware, marketSocketRoutes);
app.use("/api/strategy", authMiddleware, strategyRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

module.exports = app;
