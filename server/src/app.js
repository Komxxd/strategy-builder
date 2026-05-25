const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth.routes");
const marketRoutes = require("./routes/market.routes");
const marketSocketRoutes = require("./routes/marketSocket.routes");
const strategyRoutes = require("./routes/strategy.routes");
const authMiddleware = require("./utils/authMiddleware");

const app = express();

// 1. Core Security Middlewares (Tier 1 & 2)
app.use(helmet()); // Sets various secure HTTP headers

// 2. Strict CORS Lockdown (Tier 1 - Rule 4)
const frontendUrls = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(u => u.trim())
    : ["http://localhost:5173", "http://localhost:5174", "https://corequant-dashboard.onrender.com"];

app.use(cors({
    origin: function (origin, callback) {
        // Allow if no origin (like mobile apps/curl) OR if origin is in whitelist
        if (!origin || frontendUrls.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`Blocked by CORS: Attempt from ${origin}`);
            callback(new Error('Unauthorized access from unknown origin'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));

app.use(express.json({ limit: '10kb' })); // Limit body size for security

// 3. Rate Limiting for the Auth Gateway (Tier 2 - Rule 10)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    message: { success: false, message: "Too many login attempts. Please try again after 15 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

// 4. Routes
app.use("/api/auth", authLimiter, authRoutes); // Apply rate limit to auth endpoint

// Apply API Key security to all trading/data endpoints (Tier 1 - Rule 2)
app.use("/api/market", authMiddleware, marketRoutes);
app.use("/api/market-socket", authMiddleware, marketSocketRoutes);
app.use("/api/strategy", authMiddleware, strategyRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || 'development' });
});

// 5. Global Error Handler & Stack Trace Shield (Tier 2 - Rule 9)
app.use((err, req, res, next) => {
    console.error(`[Error] ${req.method} ${req.url} - ${err.message}`);

    const isProduction = process.env.NODE_ENV === "production";

    res.status(err.status || 500).json({
        success: false,
        message: isProduction ? "A secure server error occurred." : err.message,
        error: isProduction ? {} : err.stack
    });
});

module.exports = app;

