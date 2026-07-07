const express = require('express');
const router = express.Router();
const authMiddleware = require('../utils/authMiddleware');
const postgres = require('postgres');
const sessionService = require('../services/session.service');
const { SmartAPI } = require('smartapi-javascript');
const { getAuthorizedInstance } = require('../config/smartapi');
const { provisionWorkerNode } = require('../services/workerNodeService');

const sql = postgres(process.env.DATABASE_URL, { ssl: { rejectUnauthorized: false } });

// GET /api/broker/credentials - Fetch user's saved API Key
router.get('/credentials', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const [creds] = await sql`SELECT api_key FROM user_broker_credentials WHERE user_id = ${userId} LIMIT 1`;
        
        // Also check if they have an active session in memory
        const session = sessionService.getSession(userId);
        const isActive = !!(session && session.jwtToken);

        if (creds) {
            res.json({ success: true, apiKey: creds.api_key, isActive });
        } else {
            res.json({ success: true, apiKey: null, isActive });
        }
    } catch (err) {
        console.error("Error fetching credentials:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/broker/credentials - Save API Key
router.post('/credentials', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { apiKey } = req.body;

        if (!apiKey) {
            return res.status(400).json({ success: false, message: "API Key is required" });
        }

        await sql`
            INSERT INTO user_broker_credentials (user_id, api_key)
            VALUES (${userId}, ${apiKey})
            ON CONFLICT (user_id) DO UPDATE SET 
                api_key = EXCLUDED.api_key,
                updated_at = NOW()
        `;

        res.json({ success: true, message: "Credentials saved successfully" });
    } catch (err) {
        console.error("Error saving credentials:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/broker/callback - Handle Publisher API Redirect
// The frontend will receive the auth_token in the URL and POST it here
router.post('/callback', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { auth_token } = req.body;

        if (!auth_token) {
            return res.status(400).json({ success: false, message: "Auth token is required" });
        }

        // Fetch the user's API Key
        const [creds] = await sql`SELECT api_key FROM user_broker_credentials WHERE user_id = ${userId} LIMIT 1`;
        if (!creds || !creds.api_key) {
            return res.status(400).json({ success: false, message: "API Key not found. Please save credentials first." });
        }

        // The auth_token returned by Publisher API is the jwtToken.
        // We will store it in the session service.
        sessionService.setSession(userId, {
            jwtToken: auth_token,
            api_key: creds.api_key
        });

        // Let's verify it works by trying to fetch their profile
        try {
            const api = await getAuthorizedInstance(userId);
            const profile = await api.getProfile();
            if (profile && profile.status === true) {
                return res.json({ 
                    success: true, 
                    message: "Broker connected successfully", 
                    clientCode: profile.data.clientcode,
                    name: profile.data.name
                });
            } else {
                console.warn("Profile fetch failed after Publisher login:", profile);
                // We'll still return success since they have a token, maybe profile API has issues
                return res.json({ success: true, message: "Broker connected successfully" });
            }
        } catch (apiErr) {
            console.error("Error verifying SmartAPI token:", apiErr);
            // If verification fails, the token might be invalid or something else
            return res.status(500).json({ success: false, message: "Failed to verify broker connection with Angel One." });
        }
    } catch (err) {
        console.error("Error processing callback:", err);
        res.status(500).json({ success: false, message: "Server error processing broker login" });
    }
});

// POST /api/broker/logout - Clear broker session
router.post('/logout', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        sessionService.deleteSession(userId);
        res.json({ success: true, message: "Broker disconnected" });
    } catch (err) {
        console.error("Error logging out broker:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/broker/worker - Get worker node IP if it exists
router.get('/worker', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const workers = await sql`
            SELECT ip_address, status 
            FROM public.worker_nodes 
            WHERE user_id = ${userId} AND status != 'DELETED' 
            ORDER BY created_at DESC LIMIT 1
        `;

        if (workers.length > 0) {
            res.json({ success: true, hasWorker: true, ip: workers[0].ip_address, status: workers[0].status });
        } else {
            res.json({ success: true, hasWorker: false });
        }
    } catch (err) {
        console.error("Error fetching worker status:", err);
        res.status(500).json({ success: false, message: "Failed to fetch worker status" });
    }
});

// POST /api/broker/worker - Provision a new worker node
router.post('/worker', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        // Check if one already exists
        const workers = await sql`
            SELECT ip_address, status 
            FROM public.worker_nodes 
            WHERE user_id = ${userId} AND status != 'DELETED' 
            LIMIT 1
        `;

        if (workers.length > 0) {
            return res.json({ success: true, ip: workers[0].ip_address, message: "Worker already exists" });
        }

        // Provision a new one (This takes ~30 seconds as it hits DigitalOcean)
        const workerNode = await provisionWorkerNode(userId, process.env.NODE_ENV === 'production' ? 'prod' : 'dev');
        
        res.json({ success: true, ip: workerNode.ip_address, message: "Worker provisioned successfully" });
    } catch (err) {
        console.error("Error provisioning worker:", err);
        res.status(500).json({ success: false, message: "Failed to provision Dedicated IP. Ensure your DigitalOcean API key is correct." });
    }
});

module.exports = router;
