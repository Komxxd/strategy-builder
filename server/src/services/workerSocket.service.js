/**
 * Worker Socket Service
 * Manages WebSocket connections from Worker Droplets.
 */
const sql = require('../config/db');

let workerIo;
const connectedWorkers = new Map(); // workerId -> socketId

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

        // Listen for trade results from the worker
        socket.on('trade_result', (result) => {
            console.log(`[WorkerSocket] Trade result from Worker ${socket.workerId}:`, result);
            // Here you would resolve the pending Promise waiting for this trade's execution
            // We emit a local event that `strategy.execution.js` can listen to
            workerIo.emit(`trade_completed_${result.trade_id}`, result);
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
            workerIo.removeAllListeners(`trade_completed_${tradeId}`);
            reject(new Error(`Trade ${tradeId} timed out waiting for worker response`));
        }, 10000);

        // Listen for the specific response for this trade
        const responseListener = (result) => {
            clearTimeout(timeout);
            workerIo.removeAllListeners(`trade_completed_${tradeId}`);
            if (result.status === 'SUCCESS') {
                resolve(result.data);
            } else {
                reject(new Error(result.error));
            }
        };
        workerIo.once(`trade_completed_${tradeId}`, responseListener);

        // Send the command
        console.log(`[WorkerSocket] Sending trade ${tradeId} to Worker ${workerId}`);
        socket.emit('execute_trade', payloadWithId);
    });
}

const crypto = require('crypto');

module.exports = {
    initWorkerSocket,
    executeTradeOnWorker
};
