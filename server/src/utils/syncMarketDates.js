const fs = require('fs');
const path = require('path');
const redis = require('../config/redis');

async function syncMarketDates() {
    console.log("[Sync] Scanning market-data to update available dates in Redis...");
    try {
        if (redis.status !== 'ready') {
            if (redis.status === 'wait') {
                redis.connect().catch(() => {});
            }
            await new Promise((resolve) => {
                redis.once('ready', resolve);
            });
        }
        const indexBaseDir = path.join(__dirname, "../../../market-data/index");
        if (!fs.existsSync(indexBaseDir)) {
            console.log("[Sync] No market-data/index directory found.");
            return;
        }

        const indices = fs.readdirSync(indexBaseDir);
        
        for (const index of indices) {
            const indexDir = path.join(indexBaseDir, index);
            const stat = fs.statSync(indexDir);
            
            if (stat.isDirectory()) {
                const dates = new Set();
                
                const findDates = (dir) => {
                    const files = fs.readdirSync(dir);
                    for (const file of files) {
                        const fullPath = path.join(dir, file);
                        const fileStat = fs.statSync(fullPath);
                        if (fileStat.isDirectory()) {
                            findDates(fullPath);
                        } else if (file.endsWith('.parquet')) {
                            const match = file.match(/^(\d{4}-\d{2}-\d{2})\.parquet$/);
                            if (match) {
                                dates.add(match[1]);
                            }
                        }
                    }
                };

                findDates(indexDir);
                const sortedDates = Array.from(dates).sort();
                
                // Store in Redis
                await redis.set(`backtest:dates:${index}`, JSON.stringify(sortedDates));
                console.log(`[Sync] Updated Redis with ${sortedDates.length} dates for ${index}`);
            }
        }
    } catch (err) {
        console.error("[Sync] Error syncing market dates to Redis:", err);
    }
}

module.exports = syncMarketDates;

if (require.main === module) {
    syncMarketDates().then(() => {
        console.log("[Sync] Finished.");
        process.exit(0);
    });
}
