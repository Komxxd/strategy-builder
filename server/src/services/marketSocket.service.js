const { WebSocketV2 } = require("smartapi-javascript");

let socket = null;
let isConnected = false;
let io = null; // Frontend socket.io instance

function setIo(_io) {
    io = _io;
}

function initMarketSocket({ jwtToken, feedToken, clientCode, apiKey }) {
    if (socket) {
        if (socket.terminate) socket.terminate();
        else if (socket.close) socket.close();
        socket = null;
        isConnected = false;
    }

    if (!jwtToken || !feedToken) {
        throw new Error("jwtToken and feedToken are required to init market socket");
    }

    socket = new WebSocketV2({
        jwttoken: jwtToken,
        feedtype: feedToken,
        apikey: apiKey || process.env.SMARTAPI_API_KEY,
        clientcode: clientCode || process.env.SMARTAPI_CLIENT_ID,
    });

    socket.connect().then(() => {
        isConnected = true;
        console.log("Market WebSocket connected for client:", clientCode);
    }).catch(err => {
        console.error("Market WebSocket connection error:", err);
    });

    return socket;
}

function disconnectMarketSocket() {
    if (socket) {
        if (socket.terminate) socket.terminate();
        else if (socket.close) socket.close();
        socket = null;
        isConnected = false;
        console.log("Market WebSocket disconnected.");
    }
}

module.exports = {
    initMarketSocket,
    setIo,
    disconnectMarketSocket
};
