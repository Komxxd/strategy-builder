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
            ? import.meta.env.VITE_API_BASE_URL.replace(/\/api\/?$/, "")
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

export async function getBrokerStatus() {
    const res = await fetch(`${API_BASE}/auth/status`, {
        headers: getHeaders(),
    });
    return res.json();
}

export async function getConnectionStatus() {
    const res = await fetch(`${API_BASE}/market-socket/status`, {
        headers: getHeaders(),
    });
    return res.json();
}

export async function connectSocket() {
    const res = await fetch(`${API_BASE}/market-socket/connect`, {
        method: "POST",
        headers: getHeaders(),
    });
    return res.json();
}

export async function disconnectSocket() {
    const res = await fetch(`${API_BASE}/market-socket/disconnect`, {
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

export async function fetchBacktestDates(index) {
    const res = await fetch(`${API_BASE}/market/backtest-dates?index=${index}`, {
        headers: getHeaders(),
    });
    return res.json();
}

export async function runBacktest(strategyId, fromDate, toDate) {
    const res = await fetch(`${API_BASE}/strategy/backtest`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ strategyId, fromDate, toDate }),
    });
    return res.json();
}

export async function runCombinedBacktest(strategyIds, fromDate, toDate) {
    const res = await fetch(`${API_BASE}/strategy/backtest/combined`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ strategyIds, fromDate, toDate }),
    });
    return res.json();
}

export async function getBacktestStatus(jobId) {
    const res = await fetch(`${API_BASE}/strategy/backtest/status/${jobId}`, {
        headers: getHeaders(),
    });
    return res.json();
}