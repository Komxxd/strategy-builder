const fs = require("fs");
const path = require("path");

const INSTRUMENT_PATH = path.join(__dirname, "../data/instruments.json");

let instruments = [];
let loaded = false;

function loadInstruments() {
    if (loaded) return;
    if (!fs.existsSync(INSTRUMENT_PATH)) return;
    instruments = JSON.parse(fs.readFileSync(INSTRUMENT_PATH, "utf-8"));
    loaded = true;
}

function sortExpiry(a, b) {
    return new Date(a) - new Date(b);
}

function getOptionChain({ symbol, exchange, expiry }) {
    loadInstruments();

    const options = instruments.filter(
        (inst) =>
            inst.exch_seg === exchange &&
            (inst.instrumenttype === "OPTIDX" ||
                inst.instrumenttype === "OPTSTK") &&
            inst.name === symbol
    );

    if (options.length === 0) {
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiries = [
        ...new Set(options.map((o) => o.expiry).filter(Boolean)),
    ]
        .filter(d => new Date(d) >= today)
        .sort(sortExpiry);

    const selectedExpiry = expiry || expiries[0];

    const expiryOptions = options.filter(
        (o) => o.expiry === selectedExpiry
    );

    const chainMap = {};

    for (const opt of expiryOptions) {
        const strike = Number(opt.strike) / 100;

        if (!chainMap[strike]) {
            chainMap[strike] = {
                strike,
                CE: null,
                PE: null,
            };
        }

        if (opt.symbol.endsWith("CE")) {
            chainMap[strike].CE = opt;
        } else if (opt.symbol.endsWith("PE")) {
            chainMap[strike].PE = opt;
        }
    }

    const chain = Object.values(chainMap).sort(
        (a, b) => a.strike - b.strike
    );

    return {
        underlying: symbol,
        expiry: selectedExpiry,
        expiries,
        chain,
    };
}

module.exports = {
    getOptionChain,
};
