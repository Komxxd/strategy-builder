import { io } from "socket.io-client";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";
const API_KEY = import.meta.env.VITE_API_KEY || "my-super-secret-local-api-key-123";

const getHeaders = () => ({
    "Content-Type": "application/json",
    "x-api-key": API_KEY
});

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

export async function loginBackend() {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: getHeaders(),
    });
    return res.json();
}

export async function logoutBackend() {
    const res = await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: getHeaders(),
    });
    return res.json();
}

export async function getLTP({ exchange, symboltoken, tradingsymbol, connectionId }) {
    const res = await fetch(`${API_BASE}/market/ltp`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ exchange, symboltoken, tradingsymbol, connectionId }),
    });
    return res.json();
}

export async function subscribeToTokens({ exchangeType, tokens }) {
    const res = await fetch(`${API_BASE}/market-socket/subscribe`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ exchangeType, tokens }),
    });
    return res.json();
}

export async function fetchCandles({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    const res = await fetch(`${API_BASE}/market/candles`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ exchange, symboltoken, interval, fromdate, todate, connectionId }),
    });
    return res.json();
}


