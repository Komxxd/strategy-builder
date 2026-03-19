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

const authService = require("./services/auth.service");

io.on("connection", (socket) => {
    console.log("Frontend connected:", socket.id);
    socket.emit("broker_status", { connected: !!authService.getSession() });

    socket.on("disconnect", () => {
        console.log("Frontend disconnected:", socket.id);
    });
});

// Auto-download instruments if they don't exist or are older than 24 hours
const INSTRUMENT_PATH = path.join(__dirname, "./data/instruments.json");
const shouldDownload = !fs.existsSync(INSTRUMENT_PATH) || (Date.now() - fs.statSync(INSTRUMENT_PATH).mtimeMs > 24 * 60 * 60 * 1000);

if (shouldDownload) {
    console.log("Instruments file stale or missing. Downloading...");
    downloadInstruments()
        .then(() => {
            console.log("Instruments downloaded successfully");
            // Clear strategy service cache if needed (it reloads via loadInstruments() check)
        })
        .catch(err => console.error("Error downloading instruments:", err));
}

// Keep-Alive Ping for Render Free Tier
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
    const https = require("https");
    setInterval(() => {
        console.log(`[Keep-Alive] Sending self-ping to: ${RENDER_EXTERNAL_URL}/api/health`);
        https.get(`${RENDER_EXTERNAL_URL}/api/health`).on('error', (err) => {
            console.error('[Keep-Alive] Ping failed:', err.message);
        });
    }, 10 * 60 * 1000); // 10 minutes
    console.log(`Keep-alive interval started for ${RENDER_EXTERNAL_URL}`);
}



server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

});
