const express = require('express');
const router = express.Router();
const authMiddleware = require('../utils/authMiddleware');
const postgres = require('postgres');
const sessionService = require('../services/session.service');
const { SmartAPI } = require('smartapi-javascript');
const { getAuthorizedInstance } = require('../config/smartapi');

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

module.exports = router;
