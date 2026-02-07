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

        const file = fs.createWriteStream(OUTPUT_PATH);

        https.get(INSTRUMENT_URL, (response) => {
            response.pipe(file);

            file.on("finish", () => {
                file.close();
                resolve();
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
