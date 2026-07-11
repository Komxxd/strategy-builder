require("dotenv").config();
const { io } = require("socket.io-client");
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");

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
const socket = io(`${MASTER_SERVER_URL}/workers`, {
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

// Angel One WebSocket instance
let angelSocket = null;

// Connect to Angel WebSocket explicitly without subscribing
socket.on("connect_angel_socket", (payload) => {
    const { jwtToken, feedToken, api_key, client_code } = payload;

    if (angelSocket) {
        console.log("Angel WebSocket already connected");
        socket.emit("market_socket_status", { connected: true });
        return;
    }

    console.log(`Initializing Angel One WebSocket for ${client_code}`);
    angelSocket = new WebSocketV2({
        jwttoken: jwtToken,
        feedtype: feedToken || jwtToken,
        apikey: api_key,
        clientcode: client_code
    });

    angelSocket.connect().then(() => {
        console.log("Worker successfully connected to Angel One WebSocket");
        socket.emit("market_socket_status", { connected: true });

        angelSocket.on("tick", (tick) => {
            socket.emit("live_tick", tick);
        });

        angelSocket.on("error", (err) => {
            console.error("Angel WebSocket Error:", err);
        });

        angelSocket.on("close", () => {
            console.log("Angel WebSocket Closed");
            angelSocket = null;
            socket.emit("market_socket_status", { connected: false });
        });

    }).catch(err => {
        console.error("Worker failed to connect to Angel One WebSocket", err);
    });
});

// Listen for market data subscription commands
socket.on("subscribe_ticks", (payload) => {
    const { jwtToken, feedToken, api_key, client_code, exchangeType, tokens } = payload;

    if (!angelSocket) {
        console.log(`Initializing Angel One WebSocket for ${client_code}`);
        angelSocket = new WebSocketV2({
            jwttoken: jwtToken,
            feedtype: feedToken || jwtToken, // Fallback if Publisher API doesn't provide feedToken
            apikey: api_key,
            clientcode: client_code
        });

        angelSocket.connect().then(() => {
            console.log("Worker successfully connected to Angel One WebSocket");
            socket.emit("market_socket_status", { connected: true });

            angelSocket.on("tick", (tick) => {
                // Instantly relay the tick back to the Master Server
                socket.emit("live_tick", tick);
            });

            angelSocket.on("error", (err) => {
                console.error("Angel WebSocket Error:", err);
            });

            angelSocket.on("close", () => {
                console.log("Angel WebSocket Closed");
                angelSocket = null;
                socket.emit("market_socket_status", { connected: false });
            });

            angelSocket.fetchData({
                correlationId: `worker_sub_${Date.now()}`,
                action: 1,
                mode: 1,
                exchangeType,
                tokens
            });
        }).catch(err => {
            console.error("Worker failed to connect to Angel One WebSocket", err);
        });
    } else {
        // Already connected, just subscribe to the new tokens
        try {
            angelSocket.fetchData({
                correlationId: `worker_sub_${Date.now()}`,
                action: 1,
                mode: 1,
                exchangeType,
                tokens
            });
        } catch (err) {
            console.error("Failed to fetch data on existing socket:", err);
        }
    }
});

// Listen for trade execution commands
socket.on("execute_trade", async (tradePayload) => {
    console.log("Received trade command:", tradePayload);

    try {
        const { is_paper_trading, api_key, client_code, jwtToken, order_details, trade_id } = tradePayload;

        // --- HANDLE PAPER TRADING ---
        if (is_paper_trading) {
            console.log(`[Trade ${trade_id}] Processing PAPER TRADE...`);

            // Simulate realistic network delay (50ms)
            setTimeout(() => {
                const mockOrderId = `PAPER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
                const mockUniqueId = `UPAPER_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

                console.log(`[Trade ${trade_id}] Paper trade completed successfully.`);
                socket.emit('trade_result', {
                    trade_id,
                    status: 'SUCCESS',
                    data: {
                        orderid: mockOrderId,
                        uniqueorderid: mockUniqueId
                    }
                });
            }, 50);

            return; // Skip actual Angel One execution
        }

        // --- HANDLE LIVE TRADING ---
        // Initialize Angel One SmartAPI
        const smart_api = new SmartAPI({
            api_key: api_key
        });

        if (!jwtToken) {
            throw new Error("Missing JWT session token from Master. Cannot authenticate with Angel One.");
        }

        console.log("Setting JWT Session for client:", client_code);
        smart_api.setAccessToken(jwtToken);

        console.log("Session generated successfully. Placing order...");

        // Place the Order
        const orderResponse = await smart_api.placeOrder({
            ...order_details,
            variety: order_details.variety || "NORMAL",
            exchange: order_details.exchange || "NSE",
            ordertype: order_details.ordertype || "MARKET",
            producttype: order_details.producttype || "INTRADAY",
            duration: order_details.duration || "DAY"
        });

        if (!orderResponse || orderResponse.status === false || orderResponse.status === 400) {
            throw new Error(orderResponse.message || "Order placement rejected by exchange/broker");
        }

        console.log("Order placed successfully:", orderResponse);

        // Send success response back to Master (sending only the data object which contains orderid)
        socket.emit("trade_result", {
            trade_id,
            status: "SUCCESS",
            data: orderResponse.data || orderResponse
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

// Listen for trade modification commands
socket.on("modify_trade", async (tradePayload) => {
    console.log("Received modify trade command:", tradePayload);
    try {
        const { is_paper_trading, api_key, client_code, jwtToken, order_details, trade_id } = tradePayload;

        if (is_paper_trading) {
            console.log(`[Modify ${trade_id}] Processing PAPER TRADE...`);
            setTimeout(() => {
                socket.emit('modify_trade_result', {
                    trade_id,
                    status: 'SUCCESS',
                    data: { orderid: order_details.orderid }
                });
            }, 50);
            return;
        }

        const smart_api = new SmartAPI({ api_key });
        if (!jwtToken) throw new Error("Missing JWT session token from Master.");
        smart_api.setAccessToken(jwtToken);

        const response = await smart_api.modifyOrder({
            ...order_details,
            variety: order_details.variety || "NORMAL",
            ordertype: order_details.ordertype || "LIMIT"
        });

        if (!response || response.status === false || response.status === 400) {
            throw new Error(response.message || "Order modification rejected by exchange/broker");
        }

        socket.emit("modify_trade_result", {
            trade_id,
            status: "SUCCESS",
            data: response.data || response
        });
    } catch (error) {
        console.error("Failed to modify trade:", error);
        socket.emit("modify_trade_result", {
            trade_id: tradePayload.trade_id,
            status: "FAILED",
            error: error.message || "Unknown error occurred"
        });
    }
});

// Listen for trade cancellation commands
socket.on("cancel_trade", async (tradePayload) => {
    console.log("Received cancel trade command:", tradePayload);
    try {
        const { is_paper_trading, api_key, client_code, jwtToken, order_details, trade_id } = tradePayload;

        if (is_paper_trading) {
            console.log(`[Cancel ${trade_id}] Processing PAPER TRADE...`);
            setTimeout(() => {
                socket.emit('cancel_trade_result', {
                    trade_id,
                    status: 'SUCCESS',
                    data: { orderid: order_details.orderid }
                });
            }, 50);
            return;
        }

        const smart_api = new SmartAPI({ api_key });
        if (!jwtToken) throw new Error("Missing JWT session token from Master.");
        smart_api.setAccessToken(jwtToken);

        const response = await smart_api.cancelOrder({
            variety: order_details.variety || "NORMAL",
            orderid: order_details.orderid
        });

        if (!response || response.status === false || response.status === 400) {
            throw new Error(response.message || "Order cancellation rejected by exchange/broker");
        }

        socket.emit("cancel_trade_result", {
            trade_id,
            status: "SUCCESS",
            data: response.data || response
        });
    } catch (error) {
        console.error("Failed to cancel trade:", error);
        socket.emit("cancel_trade_result", {
            trade_id: tradePayload.trade_id,
            status: "FAILED",
            error: error.message || "Unknown error occurred"
        });
    }
});