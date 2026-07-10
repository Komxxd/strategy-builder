/**
 * Worker Socket Service
 * Manages WebSocket connections from Worker Droplets.
 */
const sql = require('../config/db');
const crypto = require('crypto');

let workerIo;
const connectedWorkers = new Map(); // workerId -> socket
const pendingTrades = new Map(); // trade_id -> { resolve, reject, timeout }

/**
 * Initializes the /workers namespace on the Socket.io server
 * @param {import('socket.io').Server} io 
 */
function initWorkerSocket(io) {
    workerIo = io.of('/workers');

    // Middleware to authenticate workers
    workerIo.use(async (socket, next) => {
        const { workerId, secret } = socket.handshake.auth;

        if (!workerId || !secret) {
            return next(new Error('Authentication error: Missing credentials'));
        }

        try {
            // Verify against database (In production, you'd want to cache this in Redis)
            const workers = await sql`
                SELECT id, user_id FROM public.worker_nodes 
                WHERE id = ${workerId} AND status != 'DELETED'
            `;

            if (workers.length === 0) {
                return next(new Error('Authentication error: Invalid worker ID'));
            }
            
            // NOTE: In a full production implementation, you should store a hashed version 
            // of the secret in the database and verify it here. For this MVP, we authenticate
            // via the correct UUID.
            
            socket.workerId = workerId;
            socket.userId = workers[0].user_id;
            next();
        } catch (error) {
            console.error("Worker authentication error:", error);
            next(new Error('Authentication error: Server error'));
        }
    });

    workerIo.on('connection', (socket) => {
        console.log(`[WorkerSocket] Worker ${socket.workerId} connected (User: ${socket.userId})`);
        connectedWorkers.set(socket.workerId, socket);

        // Mark worker as ACTIVE in database
        sql`UPDATE public.worker_nodes SET status = 'ACTIVE' WHERE id = ${socket.workerId}`.catch(console.error);

        socket.on('disconnect', () => {
            console.log(`[WorkerSocket] Worker ${socket.workerId} disconnected`);
            connectedWorkers.delete(socket.workerId);
            
            // Mark worker as DISCONNECTED in database
            sql`UPDATE public.worker_nodes SET status = 'DISCONNECTED' WHERE id = ${socket.workerId}`.catch(console.error);
        });

        // Track Angel One WebSocket Status from Worker
        socket.on('market_socket_status', (data) => {
            socket.angelOneConnected = data.connected;
            console.log(`[WorkerSocket] Worker ${socket.workerId} Angel One Market Socket Status: ${data.connected}`);
        });

        // Listen for live ticks relayed from the worker
        socket.on('live_tick', (tick) => {
            // Process the tick centrally as if it came from the local socket
            const marketSocketService = require("./marketSocket.service");
            marketSocketService.processTick(tick);
        });

        // Listen for trade results from the worker
        socket.on('trade_result', (result) => {
            console.log(`[WorkerSocket] Trade result from Worker ${socket.workerId}:`, result);
            
            const pending = pendingTrades.get(result.trade_id);
            if (pending) {
                clearTimeout(pending.timeout);
                pendingTrades.delete(result.trade_id);
                if (result.status === 'SUCCESS') {
                    pending.resolve(result.data);
                } else {
                    pending.reject(new Error(result.error));
                }
            }
        });
    });
}

/**
 * Sends a trade execution command to a specific worker
 * @param {string} workerId 
 * @param {Object} tradePayload 
 * @returns {Promise<Object>} The trade result
 */
function executeTradeOnWorker(workerId, tradePayload) {
    return new Promise((resolve, reject) => {
        const socket = connectedWorkers.get(workerId);
        if (!socket) {
            return reject(new Error(`Worker ${workerId} is not currently connected`));
        }

        const tradeId = crypto.randomUUID();
        const payloadWithId = { ...tradePayload, trade_id: tradeId };

        // Set a timeout of 10 seconds for the trade to complete
        const timeout = setTimeout(() => {
            pendingTrades.delete(tradeId);
            reject(new Error(`Trade ${tradeId} timed out waiting for worker response`));
        }, 10000);

        // Store the promise handlers so the socket listener can resolve them
        pendingTrades.set(tradeId, { resolve, reject, timeout });

        // Send the command
        console.log(`[WorkerSocket] Sending trade ${tradeId} to Worker ${workerId}`);
        socket.emit('execute_trade', payloadWithId);
    });
}


/**
 * Sends a tick subscription command to a specific user's worker node
 * @param {string} userId 
 * @param {string} exchange 
 * @param {number} exchangeType 
 * @param {string[]} tokens 
 * @returns {boolean} True if the command was sent to a worker, false if no worker is connected
 */
function subscribeWorkerTicks(userId, exchange, exchangeType, tokens) {
    // Find the worker socket that belongs to this userId
    let targetSocket = null;
    for (const [id, socket] of connectedWorkers.entries()) {
        if (socket.userId === userId) {
            targetSocket = socket;
            break;
        }
    }

    if (!targetSocket) {
        return false; // No worker connected for this user
    }

    // Get the user's Angel One session to extract the tokens
    const sessionService = require("./session.service");
    const session = sessionService.getSession(userId);
    
    if (!session || !session.jwtToken) {
        console.warn(`[WorkerSocket] Cannot subscribe ticks for Worker ${targetSocket.workerId}: Missing Angel One session`);
        return false; // Let the local master connection try
    }

    console.log(`[WorkerSocket] Delegating tick subscription to Worker ${targetSocket.workerId} for ${exchange}`);
    
    targetSocket.emit('subscribe_ticks', {
        jwtToken: session.jwtToken,
        feedToken: session.feedToken,
        api_key: session.api_key || process.env.SMARTAPI_API_KEY,
        client_code: session.client_code || process.env.SMARTAPI_CLIENT_ID,
        exchangeType: exchangeType,
        tokens: tokens
    });

    return true; // Successfully routed to worker
}

function hasWorkerConnected(userId) {
    for (const [id, socket] of connectedWorkers.entries()) {
        if (socket.userId === userId) {
            return true;
        }
    }
    return false;
}

function isWorkerAngelOneConnected(userId) {
    for (const [id, socket] of connectedWorkers.entries()) {
        if (socket.userId === userId) {
            return !!socket.angelOneConnected;
        }
    }
    return false;
}

function connectWorkerAngelSocket(userId) {
    let targetSocket = null;
    for (const [id, socket] of connectedWorkers.entries()) {
        if (socket.userId === userId) {
            targetSocket = socket;
            break;
        }
    }

    if (!targetSocket) return false;

    const sessionService = require("./session.service");
    const session = sessionService.getSession(userId);
    
    if (!session || !session.jwtToken) return false;

    console.log(`[WorkerSocket] Delegating connect command to Worker ${targetSocket.workerId}`);
    
    targetSocket.emit('connect_angel_socket', {
        jwtToken: session.jwtToken,
        feedToken: session.feedToken,
        api_key: session.api_key || process.env.SMARTAPI_API_KEY,
        client_code: session.client_code || process.env.SMARTAPI_CLIENT_ID
    });

    return true;
}

module.exports = {
    initWorkerSocket,
    executeTradeOnWorker,
    subscribeWorkerTicks,
    hasWorkerConnected,
    isWorkerAngelOneConnected,
    connectWorkerAngelSocket
};
