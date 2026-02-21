const express = require("express");
const router = express.Router();
const supabase = require("../config/supabase");
const sessionService = require("../services/session.service");
const marketSocketService = require("../services/marketSocket.service");
const authMiddleware = require("../utils/authMiddleware");

// Step 2: Store platform metadata
router.post("/connect", authMiddleware, async (req, res) => {
    // We can use req.user.id instead of trust-based user_id from body
    const { api_key, client_id, connection_name } = req.body;
    const user_id = req.user.id;

    if (!user_id || !api_key || !client_id) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    try {
        // Check if connection already exists for this client_id and user
        const { data: existing } = await supabase
            .from('broker_connections')
            .select('id')
            .eq('user_id', user_id)
            .eq('client_id', client_id)
            .single();

        let connectionId;
        if (existing) {
            await supabase
                .from('broker_connections')
                .update({
                    api_key,
                    connection_name,
                    status: 'pending_auth',
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
            connectionId = existing.id;
        } else {
            const { data, error } = await supabase
                .from('broker_connections')
                .insert([
                    {
                        user_id,
                        broker_name: 'angel_one',
                        api_key,
                        client_id,
                        connection_name,
                        status: 'pending_auth'
                    }
                ])
                .select()
                .single();
            if (error) throw error;
            connectionId = data.id;
        }

        // Generate the Angel One Auth URL
        const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5001}`;
        const callbackUrl = `${backendUrl}/api/broker/angelone/callback`;
        const angelOneAuthUrl = `https://smartapi.angelone.in/publisher-login?api_key=${api_key}&client_id=${client_id}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${connectionId}`;

        res.json({
            success: true,
            broker_connection_id: connectionId,
            auth_url: angelOneAuthUrl
        });
    } catch (err) {
        console.error("Connect error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Step 5 & 6: Angel One CallBack
router.get("/angelone/callback", async (req, res) => {
    // Note: Angel One might use 'auth_token' or 'auth_code' depending on the exact version/app type
    const { auth_token, feed_token, state, auth_code } = req.query;
    const broker_connection_id = state;
    const session_token = auth_token || auth_code;

    if (!session_token || !broker_connection_id) {
        return res.status(400).send("Invalid callback parameters. Missing auth_token or state.");
    }

    try {
        // 1. Look up broker_connection
        const { data: connection, error } = await supabase
            .from('broker_connections')
            .select('*')
            .eq('id', broker_connection_id)
            .single();

        if (error || !connection) {
            console.error("Connection lookup failed:", error);
            throw new Error("Connection not found");
        }

        // 2. Store session ephemerally
        // We use the auth_token as the jwtToken for the session
        sessionService.setSession(broker_connection_id, {
            jwtToken: session_token,
            feedToken: feed_token,
            client_id: connection.client_id,
            api_key: connection.api_key
        });

        // Initialize market socket with this session
        try {
            marketSocketService.initMarketSocket({
                jwtToken: session_token,
                feedToken: feed_token,
                clientCode: connection.client_id
            });
        } catch (socketErr) {
            console.error("Failed to initialize market socket:", socketErr);
            // We don't fail the whole connection if socket fails, but it's good to log
        }

        // 3. Mark connection as connected
        await supabase
            .from('broker_connections')
            .update({
                status: 'connected',
                last_connected_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', broker_connection_id);

        // Redirect back to frontend
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendUrl}/?connected=true&connection_id=${broker_connection_id}`);
    } catch (err) {
        console.error("Callback error:", err);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendUrl}/?error=${encodeURIComponent(err.message)}`);
    }
});

// Get all connections for a user
router.get("/connections/:user_id", authMiddleware, async (req, res) => {
    try {
        // Security check: user can only see their own connections
        if (req.user.id !== req.params.user_id) {
            return res.status(403).json({ success: false, message: "Forbidden" });
        }

        const { data, error } = await supabase
            .from('broker_connections')
            .select('*')
            .eq('user_id', req.params.user_id);

        if (error) throw error;

        // Check which ones are still in cache
        const updatedData = data.map(conn => ({
            ...conn,
            is_session_active: !!sessionService.getSession(conn.id)
        }));

        res.json({ success: true, data: updatedData });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
