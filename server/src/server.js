require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const marketSocketService = require("./services/marketSocket.service");
const downloadInstruments = require("./utils/downloadInstruments");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5001;

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

marketSocketService.setIo(io);

io.on("connection", (socket) => {
    console.log("Frontend connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Frontend disconnected:", socket.id);
    });
});

// Auto-download instruments if they don't exist
const INSTRUMENT_PATH = path.join(__dirname, "./data/instruments.json");
if (!fs.existsSync(INSTRUMENT_PATH)) {
    console.log("Instruments file not found. Downloading...");
    downloadInstruments()
        .then(() => console.log("Instruments downloaded successfully"))
        .catch(err => console.error("Error downloading instruments:", err));
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
