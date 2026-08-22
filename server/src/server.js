require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const marketSocketService = require("./services/marketSocket.service");
const downloadInstruments = require("./utils/downloadInstruments");
const strategyService = require("./services/strategy.service");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5001;

const server = http.createServer(app);

const frontendUrls = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : ["http://localhost:5173", "http://localhost:5174"];

const io = new Server(server, {
    cors: {
        origin: frontendUrls,
        methods: ["GET", "POST"],
        credentials: true
    }
});

marketSocketService.setIo(io);

// Initialize the Worker Nodes WebSocket Namespace
const workerSocketService = require("./services/workerSocket.service");
workerSocketService.initWorkerSocket(io);

const authService = require("./services/auth.service");

io.on("connection", (socket) => {
    console.log("Frontend connected:", socket.id);

    // Join a user-scoped room so alerts/events can be sent to a specific user only
    const userId = socket.handshake.auth?.userId;
    if (userId) {
        socket.join(`user:${userId}`);
        console.log(`Frontend socket ${socket.id} joined room user:${userId}`);
    }

    // Emit both statuses independently so the UI can show two separate pills
    socket.emit("broker_status", { connected: !!authService.getSession() });
    socket.emit("socket_status", { connected: marketSocketService.isSocketConnected() });

    // Send initial instruments timestamp
    try {
        const INSTRUMENT_PATH = path.join(__dirname, "./data/instruments.json");
        const INSTRUMENT_OLD_PATH = path.join(__dirname, "./dataOld/instruments.json");
        let lastUpdated = null;
        if (fs.existsSync(INSTRUMENT_PATH)) lastUpdated = fs.statSync(INSTRUMENT_PATH).mtimeMs;
        else if (fs.existsSync(INSTRUMENT_OLD_PATH)) lastUpdated = fs.statSync(INSTRUMENT_OLD_PATH).mtimeMs;
        socket.emit("instruments_status", { lastUpdated });
    } catch (e) {
        // Safe fail
    }

    socket.on("disconnect", () => {
        console.log("Frontend disconnected:", socket.id);
    });
});

const cron = require("node-cron");
const { reloadInstruments } = require("./services/trading/strategy.instruments");

// Auto-download instruments on startup to ensure fresh data
console.log("Server starting up. Downloading fresh instruments list...");
downloadInstruments()
    .then(() => {
        console.log("Instruments downloaded successfully on startup");
        reloadInstruments();
        io.emit("instruments_status", { lastUpdated: Date.now() });
    })
    .catch(err => {
        console.error("Error downloading instruments on startup:", err);
        console.log("Attempting to load fallback instruments...");
        reloadInstruments(); // Fallback to whatever is in data or dataOld
        // Re-broadcast the old timestamp
        try {
            const INSTRUMENT_PATH = path.join(__dirname, "./data/instruments.json");
            const INSTRUMENT_OLD_PATH = path.join(__dirname, "./dataOld/instruments.json");
            let lastUpdated = null;
            if (fs.existsSync(INSTRUMENT_PATH)) lastUpdated = fs.statSync(INSTRUMENT_PATH).mtimeMs;
            else if (fs.existsSync(INSTRUMENT_OLD_PATH)) lastUpdated = fs.statSync(INSTRUMENT_OLD_PATH).mtimeMs;
            io.emit("instruments_status", { lastUpdated });
        } catch(e) {}
    });

// Schedule daily instrument download at 8:00 PM IST
cron.schedule("0 20 * * *", () => {
    console.log("[Cron] Auto-updating instrument list at 8:00 PM IST...");
    downloadInstruments()
        .then(() => {
            console.log("[Cron] Instruments auto-updated successfully");
            reloadInstruments();
            io.emit("instruments_status", { lastUpdated: Date.now() });
        })
        .catch(err => {
            console.error("[Cron] Error auto-updating instruments:", err);
            console.log("[Cron] Keeping existing instruments in memory.");
        });
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
/**
 * Graceful Shutdown Handler
 *
 * PM2 sends SIGTERM before restarting/stopping the process.
 * Without this handler, the process exits immediately, which means:
 *   - Pending DB writes (the 5s batch queue) are lost → trades show wrong final state
 *   - The Angel One WebSocket is killed mid-heartbeat (causes a reconnect on restart)
 *   - In-flight HTTP requests are dropped
 *
 * This handler gives the server a clean 10 seconds to finish up before forcing exit.
 */
async function gracefulShutdown(signal) {
    console.log(`\n[Server] ${signal} received. Starting graceful shutdown...`);

    // Step 1: Stop accepting new HTTP connections
    server.close(() => {
        console.log("[Server] HTTP server closed. No new connections accepted.");
    });

    // Step 2: Flush any pending DB updates BEFORE disconnecting anything.
    // The DbWriter batches updates every 5s — if we shut down between cycles,
    // we lose the last batch. Calling flush ensures they're written to Neon first.
    // Timeout: if Neon is unreachable (cold start), don't hold up the shutdown forever.
    // PM2's kill_timeout is 1600ms by default — this gives us 8s before it force-kills.
    try {
        console.log("[Server] Flushing pending DB writes...");
        const flushTimeout = new Promise(resolve => setTimeout(() => resolve("timeout"), 8000));
        const result = await Promise.race([strategyService.flushPendingDbWrites(), flushTimeout]);
        if (result === "timeout") {
            console.warn("[Server] DB flush timed out after 8s — some pending writes may be lost.");
        } else {
            console.log("[Server] DB writes flushed ✅");
        }
    } catch (err) {
        console.error("[Server] Failed to flush DB writes on shutdown:", err.message);
    }

    // Step 3: Disconnect the Angel One WebSocket cleanly
    try {
        marketSocketService.disconnectMarketSocket();
        console.log("[Server] Angel One WebSocket disconnected ✅");
    } catch (err) {
        console.error("[Server] Error disconnecting WebSocket:", err.message);
    }

    console.log("[Server] Graceful shutdown complete. Exiting.");
    process.exit(0);
}

// PM2 sends SIGTERM for restarts/stops
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
// Ctrl+C in development
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// Catch unhandled promise rejections to prevent silent crashes
process.on("unhandledRejection", (reason, promise) => {
    console.error("[Server] Unhandled Promise Rejection:", reason);
    // Don't exit — just log it. PM2 will restart if something truly breaks.
});

server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
});
