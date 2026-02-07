const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const marketRoutes = require("./routes/market.routes");
const instrumentsRoutes = require("./routes/instruments.routes");
const optionRoutes = require("./routes/options.routes");
const marketSocketRoutes = require("./routes/marketSocket.routes");
const strategyRoutes = require("./routes/strategy.routes");
const brokerRoutes = require("./routes/broker.routes");
const ordersRoutes = require("./routes/orders.routes");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/instruments", instrumentsRoutes);
app.use("/api/options", optionRoutes);
app.use("/api/market-socket", marketSocketRoutes);
app.use("/api/strategy", strategyRoutes);
app.use("/api/broker", brokerRoutes);
app.use("/api/orders", ordersRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

module.exports = app;
