const fs = require("fs");
const path = require("path");

const INSTRUMENT_PATH = path.join(__dirname, "../data/instruments.json");

let instruments = [];
let loaded = false;

function loadInstruments() {
    if (loaded && instruments.length > 0) return;

    if (!fs.existsSync(INSTRUMENT_PATH)) {
        console.warn("Instruments file not found. Please download it first.");
        return;
    }

    try {
        const raw = fs.readFileSync(INSTRUMENT_PATH, "utf-8");
        if (!raw || raw.trim() === "") {
            console.warn("Instruments file is empty.");
            return;
        }
        instruments = JSON.parse(raw);
        loaded = true;
        console.log("Total instruments loaded:", instruments.length);
    } catch (err) {
        console.error("Error parsing instruments.json:", err.message);
        // If it's corrupted, we might want to delete it so it redownloads on next restart
        loaded = false;
    }
}

function searchInstruments({ query, exchange, type }) {
    loadInstruments();

    return instruments.filter((inst) => {
        // ---- text search (symbol + name) ----
        const text = `${inst.symbol || ""} ${inst.name || ""}`.toLowerCase();
        if (query && !text.includes(query.toLowerCase())) {
            return false;
        }

        // ---- exchange filter ----
        if (exchange && inst.exch_seg !== exchange) {
            return false;
        }

        // ---- type filter ----
        if (type === "EQUITY") {
            return (
                inst.instrumenttype === "" ||
                inst.instrumenttype === "AMXSTK"
            );
        }

        if (type === "INDEX") {
            return (
                inst.instrumenttype === "AMXIDX" ||
                inst.instrumenttype === "INDEX"
            );
        }

        if (type === "FUTURES") {
            return (
                inst.instrumenttype === "FUTSTK" ||
                inst.instrumenttype === "FUTIDX"
            );
        }

        if (type === "OPTIONS") {
            return (
                inst.instrumenttype === "OPTSTK" ||
                inst.instrumenttype === "OPTIDX"
            );
        }

        return true;
    }).slice(0, 50);
}

module.exports = { searchInstruments };
