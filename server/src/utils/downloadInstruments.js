const fs = require("fs");
const path = require("path");
const https = require("https");

const INSTRUMENT_URL =
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const DATA_DIR = path.join(__dirname, "../data");
const DATA_OLD_DIR = path.join(__dirname, "../dataOld");
const TEMP_DIR = path.join(__dirname, "../temp");

const DATA_PATH = path.join(DATA_DIR, "instruments.json");
const DATA_OLD_PATH = path.join(DATA_OLD_DIR, "instruments.json");
const TEMP_PATH = path.join(TEMP_DIR, "instruments.json");

function downloadInstrumentMaster() {
    return new Promise((resolve, reject) => {
        // Ensure directories exist
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(DATA_OLD_DIR)) fs.mkdirSync(DATA_OLD_DIR, { recursive: true });
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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

                    // 1. Write to temp first
                    fs.writeFileSync(TEMP_PATH, JSON.stringify(filtered));
                    console.log("[Download] Downloaded to temp folder.");

                    // 2. Delete dataOld if it exists
                    if (fs.existsSync(DATA_OLD_PATH)) {
                        fs.unlinkSync(DATA_OLD_PATH);
                        console.log("[Download] Deleted existing dataOld file.");
                    }

                    // 3. Move data to dataOld if data exists
                    if (fs.existsSync(DATA_PATH)) {
                        fs.renameSync(DATA_PATH, DATA_OLD_PATH);
                        console.log("[Download] Moved current data to dataOld.");
                    }

                    // 4. Move temp to data
                    fs.renameSync(TEMP_PATH, DATA_PATH);
                    console.log("[Download] Moved new file from temp to data.");

                    console.log(`Instruments filtered: ${originalCount} total → ${filtered.length} OPTIDX saved (${(fs.statSync(DATA_PATH).size / (1024 * 1024)).toFixed(1)} MB)`);
                    resolve();
                } catch (parseErr) {
                    if (fs.existsSync(TEMP_PATH)) fs.unlinkSync(TEMP_PATH);
                    reject(parseErr);
                }
            });
        }).on("error", (err) => {
            if (fs.existsSync(TEMP_PATH)) fs.unlinkSync(TEMP_PATH);
            reject(err);
        });
    });
}

module.exports = downloadInstrumentMaster;
