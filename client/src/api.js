import { io } from "socket.io-client";
import { supabase } from './lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

let socket = null;

export function initSocket() {
    if (!socket) {
        const socketUrl = import.meta.env.VITE_API_BASE_URL
            ? import.meta.env.VITE_API_BASE_URL.replace('/api', '')
            : "http://localhost:5001";
        socket = io(socketUrl);
    }
    return socket;
}

async function getAuthHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    return {
        "Content-Type": "application/json",
        "Authorization": session ? `Bearer ${session.access_token}` : "",
    };
}

export async function loginBackend() {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: await getAuthHeaders(),
    });
    return res.json();
}

export async function getLTP({ exchange, symboltoken, tradingsymbol, connectionId }) {
    const res = await fetch(`${API_BASE}/market/ltp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange, symboltoken, tradingsymbol, connectionId }),
    });
    return res.json();
}

export async function subscribeToTokens({ exchangeType, tokens }) {
    const res = await fetch(`${API_BASE}/market-socket/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchangeType, tokens }),
    });
    return res.json();
}

export async function fetchCandles({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    const res = await fetch(`${API_BASE}/market/candles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange, symboltoken, interval, fromdate, todate, connectionId }),
    });
    return res.json();
}

export async function connectBroker(payload) {
    const res = await fetch(`${API_BASE}/broker/connect`, {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify(payload),
    });
    return res.json();
}

export async function getBrokerConnections(userId) {
    const res = await fetch(`${API_BASE}/broker/connections/${userId}`, {
        headers: await getAuthHeaders()
    });
    return res.json();
}

