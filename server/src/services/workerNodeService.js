/**
 * Worker Node Service
 * Orchestrates the creation of Worker Droplets and updates the Supabase Database.
 */
const { createWorkerDroplet, waitForDropletIp } = require('./digitalocean');
const sql = require('../config/db'); // The postgres connection

const crypto = require('crypto');

/**
 * Provisions a new Worker Node for a given user.
 * 
 * 1. Generates a worker ID and secret
 * 2. Calls DO API to create a Droplet (with Cloud-Init script)
 * 3. Waits for DO to assign a public IPv4 address
 * 4. Saves the Droplet ID and IP to the `worker_nodes` table
 * 5. Updates `user_broker_credentials` to link this worker
 * 
 * @param {string} userId - The Supabase user UUID
 * @param {string} env - 'dev' or 'prod' (defaults to process.env.NODE_ENV)
 * @returns {Promise<Object>} The created worker node record
 */
async function provisionWorkerNode(userId, env = 'dev') {
    try {
        console.log(`[Provision] Starting worker node provisioning for User: ${userId}`);
        
        // Prepare credentials
        const workerId = crypto.randomUUID();
        const workerSecret = crypto.randomBytes(32).toString('hex');
        const masterServerUrl = process.env.BACKEND_URL || 'http://localhost:5001';
        
        // 1. Create Droplet
        const droplet = await createWorkerDroplet(userId, env, masterServerUrl, workerSecret, workerId);
        console.log(`[Provision] Droplet created with ID: ${droplet.id}. Waiting for IP...`);
        
        // 2. Wait for IP
        const ipAddress = await waitForDropletIp(droplet.id);
        console.log(`[Provision] IP assigned: ${ipAddress}`);
        
        // 3. Save to database
        const newWorker = await sql`
            INSERT INTO public.worker_nodes (id, user_id, droplet_id, ip_address, status, environment)
            VALUES (${workerId}, ${userId}, ${droplet.id.toString()}, ${ipAddress}, 'PROVISIONING', ${env})
            RETURNING *;
        `;
        
        const workerNode = newWorker[0];

        // 4. Link to broker credentials
        await sql`
            UPDATE public.user_broker_credentials
            SET assigned_worker_id = ${workerNode.id}
            WHERE user_id = ${userId}
        `;

        console.log(`[Provision] Successfully linked Worker Node ${workerNode.id} to user ${userId}.`);
        
        return workerNode;
    } catch (error) {
        console.error('[Provision] Failed to provision worker node:', error);
        throw error;
    }
}

/**
 * Marks a worker node as ACTIVE after its WebSocket successfully connects
 * @param {string} workerId 
 */
async function activateWorkerNode(workerId) {
    await sql`
        UPDATE public.worker_nodes
        SET status = 'ACTIVE'
        WHERE id = ${workerId}
    `;
}

module.exports = {
    provisionWorkerNode,
    activateWorkerNode
};
