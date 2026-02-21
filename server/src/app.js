const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const marketRoutes = require("./routes/market.routes");
const marketSocketRoutes = require("./routes/marketSocket.routes");
const strategyRoutes = require("./routes/strategy.routes");
const brokerRoutes = require("./routes/broker.routes");

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

app.use("/api/auth", authRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/market-socket", marketSocketRoutes);
app.use("/api/strategy", strategyRoutes);
app.use("/api/broker", brokerRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

module.exports = app;
