const fs = require("fs");
const path = require("path");
const redis = require("../../config/redis");
const { getLtpSecure } = require("./strategy.state");

// Note: Instruments path changed from ../data/... to ../../data/... because this file is in a subdirectory
const INSTRUMENT_PATH = path.join(__dirname, "../../data/instruments.json");
let instruments = [];

// Redis cache TTL for instrument lookups (24 hours).
// The IST-aware date filter handles expiry correctness regardless of cache age,
// so a longer TTL is safe and avoids re-parsing the large instruments file.
const INSTRUMENT_CACHE_TTL = 86400;

/**
 * Returns today's date at midnight in IST (UTC+5:30).
 * Critical: The server runs in UTC (DigitalOcean), but Indian markets use IST.
 * Without this, on expiry days at ~9:15 AM IST (3:45 AM UTC), `new Date()` is
 * still "yesterday" in UTC, causing the system to select expired/monthly contracts.
 */
function getTodayIST() {
    const now = new Date();
    // Shift to IST by adding 5h30m offset
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    istNow.setHours(0, 0, 0, 0);
    return istNow;
}

function loadInstruments() {
    if (instruments.length > 0) return;
    try {
        if (fs.existsSync(INSTRUMENT_PATH)) {
            const raw = fs.readFileSync(INSTRUMENT_PATH, "utf-8");
            instruments = JSON.parse(raw);
            const fileSizeMB = (Buffer.byteLength(raw, 'utf-8') / (1024 * 1024)).toFixed(1);
            console.log(`Instruments loaded: ${instruments.length} records (${fileSizeMB} MB file)`);
        }
    } catch (err) {
        console.error("Strategy Service: Error loading instruments", err.message);
    }
}

async function reloadInstruments() {
    try {
        instruments = []; // Clear memory
        
        // Find all instrument cache keys in Redis
        let cursor = '0';
        const keysToDelete = [];
        do {
            const [newCursor, keys] = await redis.scan(cursor, 'MATCH', 'instr:*', 'COUNT', 100);
            cursor = newCursor;
            if (keys.length > 0) {
                keysToDelete.push(...keys);
            }
        } while (cursor !== '0');
        
        // Delete all found keys
        if (keysToDelete.length > 0) {
            await redis.del(keysToDelete);
            console.log(`[Instruments] Cleared ${keysToDelete.length} stale Redis cache keys.`);
        }
        
        // Reload from newly downloaded file into memory
        loadInstruments();
        console.log(`[Instruments] In-memory instruments list reloaded successfully.`);
    } catch (err) {
        console.error("[Instruments] Failed to reload instruments:", err.message);
    }
}

function getATMStrike(indexName, spotPrice) {
    let step = 100;
    if (indexName === "NIFTY") step = 50;
    return Math.round(spotPrice / step) * step;
}

function getLegStrikeSelection({ index, option_type, strike, spotPrice }) {
    const atmStrike = getATMStrike(index, spotPrice);
    const strikeStr = strike || "ATM";
    const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
    const type = match ? match[1] : "ATM";
    const offset = match && match[2] ? parseInt(match[2]) : 0;

    let step = 100;
    if (index === "NIFTY") step = 50;
    else if (index === "FINNIFTY") step = 50;

    let targetStrike = atmStrike;
    if (type === "OTM") {
        targetStrike = option_type === "CE" ? atmStrike + (offset * step) : atmStrike - (offset * step);
    } else if (type === "ITM") {
        targetStrike = option_type === "CE" ? atmStrike - (offset * step) : atmStrike + (offset * step);
    }

    return { atmStrike, targetStrike, strikeLabel: strikeStr };
}

function resolveExpiryDate(matches, expiryType = 'weekly') {
    // 1. Get unique sorted expiry dates
    const uniqueExpiries = [...new Set(matches.map(m => m.expiry))].sort((a, b) => new Date(a) - new Date(b));
    if (uniqueExpiries.length === 0) return null;

    if (expiryType === 'weekly') return uniqueExpiries[0];
    if (expiryType === 'next_weekly') return uniqueExpiries[1] || uniqueExpiries[0];

    // For monthly and next_monthly
    const months = {};
    for (const exp of uniqueExpiries) {
        // e.g. "25JUN2026" -> parse to Date
        const d = new Date(exp);
        const yyyymm = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
        if (!months[yyyymm]) months[yyyymm] = [];
        months[yyyymm].push(exp);
    }
    
    // Sort month keys
    const sortedMonthKeys = Object.keys(months).sort();
    
    if (expiryType === 'monthly') {
        const firstMonth = sortedMonthKeys[0];
        // The monthly is the LAST expiry of the first available month
        const firstMonthExpiries = months[firstMonth];
        return firstMonthExpiries[firstMonthExpiries.length - 1];
    }
    
    if (expiryType === 'next_monthly') {
        const nextMonth = sortedMonthKeys[1] || sortedMonthKeys[0];
        const nextMonthExpiries = months[nextMonth];
        return nextMonthExpiries[nextMonthExpiries.length - 1];
    }
    
    return uniqueExpiries[0];
}

async function findOptionInstrument(indexName, optionType, strike, expiryType = 'weekly') {
    let matches = [];
    try {
        const cacheKey = `instr:OPTIDX:${indexName}:${optionType}:${strike}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            matches = JSON.parse(cached);
        } else {
            loadInstruments();
            matches = instruments.filter(inst =>
                inst.name === indexName &&
                inst.instrumenttype === "OPTIDX" &&
                inst.symbol.endsWith(optionType) &&
                (parseFloat(inst.strike) / 100) === strike
            );
            // FIX: Add TTL to prevent stale instruments across expiry boundaries
            await redis.set(cacheKey, JSON.stringify(matches), 'EX', INSTRUMENT_CACHE_TTL);
        }
    } catch (err) {
        loadInstruments();
        matches = instruments.filter(inst =>
            inst.name === indexName &&
            inst.instrumenttype === "OPTIDX" &&
            inst.symbol.endsWith(optionType) &&
            (parseFloat(inst.strike) / 100) === strike
        );
    }

    // FIX: Use IST date, not UTC. Server is on DigitalOcean (UTC), markets are IST.
    const today = getTodayIST();
    matches = matches.filter(inst => new Date(inst.expiry) >= today);

    if (matches.length === 0) return null;

    const targetExpiry = resolveExpiryDate(matches, expiryType);
    if (!targetExpiry) return null;

    // Return the specific instrument matching the target expiry
    return matches.find(inst => inst.expiry === targetExpiry);
}

async function findClosestPremiumInstrument(indexName, optionType, targetPremium, connectionId, expiryType = 'weekly') {
    const exchange = indexName === "SENSEX" ? "BFO" : "NFO";
    let matchesRaw = [];

    try {
        const cacheKey = `instr:OPTIDX:${indexName}:${optionType}:ALL`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            matchesRaw = JSON.parse(cached);
        } else {
            loadInstruments();
            matchesRaw = instruments.filter(inst =>
                inst.name === indexName &&
                inst.instrumenttype === "OPTIDX" &&
                inst.symbol.endsWith(optionType)
            );
            // FIX: Add TTL to prevent stale instruments across expiry boundaries
            await redis.set(cacheKey, JSON.stringify(matchesRaw), 'EX', INSTRUMENT_CACHE_TTL);
        }
    } catch (err) {
        loadInstruments();
        matchesRaw = instruments.filter(inst =>
            inst.name === indexName &&
            inst.instrumenttype === "OPTIDX" &&
            inst.symbol.endsWith(optionType)
        );
    }

    // FIX: Use IST date, not UTC. Server is on DigitalOcean (UTC), markets are IST.
    const today = getTodayIST();

    // 1. Get all options for this index and type
    const matches = matchesRaw.filter(inst => new Date(inst.expiry) >= today);

    if (matches.length === 0) {
        throw new Error(`[Closest Premium] No ${optionType} instruments found for ${indexName} expiring after today.`);
    }

    // 2. Resolve the exact expiry date based on the user's expiryType selection
    const targetExpiry = resolveExpiryDate(matches, expiryType);
    if (!targetExpiry) {
        throw new Error(`[Closest Premium] Could not resolve ${expiryType} expiry date for ${indexName}.`);
    }

    // 3. Filter down to ONLY the strikes for that target expiry
    const currentExpiryOptions = matches.filter(inst => inst.expiry === targetExpiry);
    const tokens = currentExpiryOptions.map(inst => inst.token).filter(Boolean);

    if (tokens.length === 0) {
        throw new Error(`[Closest Premium] No tokens found for ${indexName} ${optionType} expiring on ${nearestExpiry}.`);
    }

    // 4. Batch get LTP for all tokens in this expiry (SmartAPI limits to ~50 per request)
    const tokenChunks = [];
    for (let i = 0; i < tokens.length; i += 40) {
        tokenChunks.push(tokens.slice(i, i + 40));
    }

    let allFetchedData = [];
    for (let i = 0; i < tokenChunks.length; i++) {
        try {
            const chunk = tokenChunks[i];
            const ltpRes = await getLtpSecure({
                exchange,
                symboltoken: chunk,
                connectionId
            });
            if (ltpRes?.status && ltpRes?.data?.fetched) {
                allFetchedData = allFetchedData.concat(ltpRes.data.fetched);
            } else if (ltpRes?.message) {
                console.error(`SmartAPI Error on chunk ${i}: ${ltpRes.message}`);
            }
        } catch (err) {
            console.error(`Error fetching chunk ${i} for nearest premium:`, err.message);
        }
    }

    if (allFetchedData.length === 0) {
        throw new Error(`[Closest Premium] SmartAPI returned 0 prices. Exchange: ${exchange}, Tokens requested: ${tokens.length}. Connection active?`);
    }

    let closestFound = null;
    let minDiff = Infinity;

    // 5. Find the one with the LTP closest to targetPremium
    for (const fetched of allFetchedData) {
        const diff = Math.abs(fetched.ltp - targetPremium);
        if (diff < minDiff) {
            minDiff = diff;
            closestFound = fetched;
        }
    }

    if (!closestFound) {
        throw new Error(`[Closest Premium] Could not determine closest premium mathematically for ₹${targetPremium}.`);
    }

    // 6. Return the full instrument object for the winning token
    const matchingTarget = closestFound.symbolToken || closestFound.symboltoken;
    const winner = currentExpiryOptions.find(inst => inst.token === matchingTarget);
    if (!winner) {
        throw new Error(`[Closest Premium] Matched token ${matchingTarget} not found in options list!`);
    }
    return winner;
}

module.exports = {
   loadInstruments,
   getATMStrike,
   getLegStrikeSelection,
   findOptionInstrument,
   findClosestPremiumInstrument,
   reloadInstruments
};
