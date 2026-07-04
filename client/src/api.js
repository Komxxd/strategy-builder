import { io } from "socket.io-client";
import { supabase } from "./lib/supabase";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

const getHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || "";
    return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
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

export async function loginBackend() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers,
    });
    return res.json();
}

export async function logoutBackend() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers,
    });
    return res.json();
}

export async function getBrokerStatus() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/auth/status`, {
        headers,
    });
    return res.json();
}

export async function getConnectionStatus() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market-socket/status`, {
        headers,
    });
    return res.json();
}

export async function connectSocket() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market-socket/connect`, {
        method: "POST",
        headers,
    });
    return res.json();
}

export async function disconnectSocket() {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market-socket/disconnect`, {
        method: "POST",
        headers,
    });
    return res.json();
}

export async function getLTP({ exchange, symboltoken, tradingsymbol, connectionId }) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market/ltp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ exchange, symboltoken, tradingsymbol, connectionId }),
    });
    return res.json();
}


export async function fetchCandles({ exchange, symboltoken, interval, fromdate, todate, connectionId }) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market/candles`, {
        method: "POST",
        headers,
        body: JSON.stringify({ exchange, symboltoken, interval, fromdate, todate, connectionId }),
    });
    return res.json();
}

export async function fetchBacktestDates(index) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/market/backtest-dates?index=${index}`, {
        headers,
    });
    return res.json();
}

export async function runBacktest(strategyId, fromDate, toDate) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/strategy/backtest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ strategyId, fromDate, toDate }),
    });
    return res.json();
}

export async function runCombinedBacktest(strategyIds, fromDate, toDate) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/strategy/backtest/combined`, {
        method: "POST",
        headers,
        body: JSON.stringify({ strategyIds, fromDate, toDate }),
    });
    return res.json();
}

export async function getBacktestStatus(jobId) {
    const headers = await getHeaders();
    const res = await fetch(`${API_BASE}/strategy/backtest/status/${jobId}`, {
        headers,
    });
    return res.json();
}