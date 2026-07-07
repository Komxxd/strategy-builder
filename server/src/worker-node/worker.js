const { io } = require("socket.io-client");
const { SmartAPI } = require("smartapi-javascript");
const speakeasy = require("speakeasy");

// Environment variables passed via Cloud-Init
const MASTER_SERVER_URL = process.env.MASTER_SERVER_URL;
const WORKER_ID = process.env.WORKER_ID;
const WORKER_SECRET = process.env.WORKER_SECRET;

if (!MASTER_SERVER_URL || !WORKER_ID || !WORKER_SECRET) {
    console.error("Missing required environment variables. Exiting.");
    process.exit(1);
}

console.log(`Starting Worker Node ${WORKER_ID}...`);
console.log(`Connecting to Master at ${MASTER_SERVER_URL}`);

// Connect to the Master Server
const socket = io(MASTER_SERVER_URL, {
    auth: {
        workerId: WORKER_ID,
        secret: WORKER_SECRET
    }
});

socket.on("connect", () => {
    console.log("Successfully connected to Master Server via WebSocket!");
});

socket.on("connect_error", (err) => {
    console.error("Connection failed:", err.message);
});

socket.on("disconnect", () => {
    console.log("Disconnected from Master Server.");
});

// Listen for trade execution commands
socket.on("execute_trade", async (tradePayload) => {
    console.log("Received trade command:", tradePayload);
    
    try {
        const { api_key, client_code, password, totp, order_details, trade_id } = tradePayload;

        // Initialize Angel One SmartAPI
        const smart_api = new SmartAPI({
            api_key: api_key
        });

        // Generate TOTP Pin using the secret
        const totp_pin = speakeasy.totp({
            secret: totp,
            encoding: 'base32'
        });

        // Generate Session
        console.log("Generating session for client:", client_code);
        const session = await smart_api.generateSession(client_code, password, totp_pin);
        
        if (!session || !session.data || !session.data.jwtToken) {
            throw new Error("Failed to authenticate with Angel One.");
        }

        console.log("Session generated successfully. Placing order...");
        
        // Place the Order
        const orderResponse = await smart_api.placeOrder({
            variety: order_details.variety || "NORMAL",
            tradingsymbol: order_details.tradingsymbol,
            symboltoken: order_details.symboltoken,
            transactiontype: order_details.transactiontype,
            exchange: order_details.exchange || "NSE",
            ordertype: order_details.ordertype || "MARKET",
            producttype: order_details.producttype || "INTRADAY",
            quantity: order_details.quantity
        });

        console.log("Order placed successfully:", orderResponse);

        // Send success response back to Master
        socket.emit("trade_result", {
            trade_id,
            status: "SUCCESS",
            data: orderResponse
        });

    } catch (error) {
        console.error("Failed to execute trade:", error);
        
        // Send failure response back to Master
        socket.emit("trade_result", {
            trade_id: tradePayload.trade_id,
            status: "FAILED",
            error: error.message || "Unknown error occurred"
        });
    }
});
