import { io } from "socket.io-client";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

// Tier 1 - Rule 1: No secrets in VITE_ env.
// We now retrieve the API Key from sessionStorage after a successful PasswordLock verification.
const getHeaders = () => {
    const sessionKey = sessionStorage.getItem('app_api_key');
    return {
        "Content-Type": "application/json",
        "x-api-key": sessionKey || ""
    };
};

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

// Phase 2: Password-to-Token Bridge
export async function verifyPassword(password) {
    const res = await fetch(`${API_BASE}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
    });
    return res.json();
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


export async function fetchCandles({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    const res = await fetch(`${API_BASE}/market/candles`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ exchange, symboltoken, interval, fromdate, todate, connectionId }),
    });
    return res.json();
}


