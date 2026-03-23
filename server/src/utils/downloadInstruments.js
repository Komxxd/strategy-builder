const fs = require("fs");
const path = require("path");
const https = require("https");

const INSTRUMENT_URL =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const OUTPUT_PATH = path.join(__dirname, "../data/instruments.json");

function downloadInstrumentMaster() {
    return new Promise((resolve, reject) => {
        // Ensure data directory exists
        const dataDir = path.dirname(OUTPUT_PATH);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Stream-collect the full JSON, then filter to only OPTIDX instruments
        // before writing to disk. This reduces the file from ~41MB to ~2MB,
        // saving ~100-150MB of runtime V8 heap memory.
        let rawData = '';

        https.get(INSTRUMENT_URL, (response) => {
            response.on('data', (chunk) => { rawData += chunk; });

            response.on('end', () => {
                try {
                    const all = JSON.parse(rawData);
                    rawData = ''; // Free the raw string immediately

                    // Keep ONLY option index instruments — the only type the app uses
                    const filtered = all.filter(i => i.instrumenttype === "OPTIDX");
                    const originalCount = all.length;

                    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered));
                    console.log(`Instruments filtered: ${originalCount} total → ${filtered.length} OPTIDX saved (${(fs.statSync(OUTPUT_PATH).size / (1024 * 1024)).toFixed(1)} MB)`);
                    resolve();
                } catch (parseErr) {
                    if (fs.existsSync(OUTPUT_PATH)) fs.unlinkSync(OUTPUT_PATH);
                    reject(parseErr);
                }
            });
        }).on("error", (err) => {
            if (fs.existsSync(OUTPUT_PATH)) {
                fs.unlinkSync(OUTPUT_PATH);
            }
            reject(err);
        });
    });
}

module.exports = downloadInstrumentMaster;
