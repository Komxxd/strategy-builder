const fs = require('fs');
const path = require('path');
const { getStrategyById } = require('../trading/strategy.crud');

/**
 * CORE BACKTESTING ENGINE (Basic Logic)
 * ---------------------------------------------------------------------
 * This module runs a basic backtest reading Parquet files for the Index
 * and Options to simulate entry and exit based solely on time.
 */
class BacktestEngine {
    constructor(strategyId, fromDate, toDate, userId) {
        this.strategyId = strategyId;
        this.fromDate = fromDate;
        this.toDate = toDate;
        this.userId = userId;
        
        this.strategy = null;
        this.results = {
            trades: [],
            dailySummary: {},
            totalPnL: 0,
            maxDrawdown: 0,
            winRate: 0
        };
    }

    async init() {
        const strategies = await getStrategyById(this.strategyId, this.userId);
        if (!strategies || strategies.length === 0) {
            throw new Error(`Strategy not found: ${this.strategyId}`);
        }
        this.strategy = strategies[0];
        
        if (!this.strategy.config || !this.strategy.config.legs) {
            throw new Error("Invalid strategy configuration or missing legs.");
        }
        
        console.log(`[Backtest Engine] Initialized: ${this.strategy.name} [${this.fromDate} to ${this.toDate}]`);
    }

    async readParquetFile(filePath) {
        if (!fs.existsSync(filePath)) return [];
        const { parquetRead } = await import('hyparquet');
        const bufferObj = fs.readFileSync(filePath);
        const buffer = bufferObj.buffer.slice(bufferObj.byteOffset, bufferObj.byteOffset + bufferObj.byteLength);
        
        if (buffer.byteLength < 4) {
            console.error(`File too small or empty: ${filePath}`);
            return [];
        }

        return new Promise((resolve) => {
            try {
                const readPromise = parquetRead({
                    file: buffer,
                    onComplete: resolve
                });
                if (readPromise && typeof readPromise.catch === 'function') {
                    readPromise.catch(e => {
                        console.error(`Async error parsing ${filePath}:`, e.message);
                        resolve([]);
                    });
                }
            } catch (e) {
                console.error(`Sync error parsing ${filePath}:`, e.message);
                resolve([]);
            }
        });
    }

    extractTime(row) {
        // row[8] is the explicit iso_timestamp string stored by the Python harvester for Index data
        if (row && row.length > 8 && typeof row[8] === 'string' && row[8].includes('T')) {
            const d = new Date(row[8]);
            return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
        if (row && row[1]) return row[1].toISOString().substring(11, 19); 
        return null;
    }

    extractTimeOption(row) {
        // row[13] is the explicit iso_timestamp string stored for Options data
        if (row && row.length > 13 && typeof row[13] === 'string' && row[13].includes('T')) {
            const d = new Date(row[13]);
            return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
        if (row && row[1]) return row[1].toISOString().substring(11, 19); 
        return null;
    }

    async fetchStitchedData(type, indexName, year, month, date, expiry, strike, optionType) {
        let minFilePath;
        let secFilePath;

        if (type === 'index') {
            minFilePath = path.join(__dirname, `../../../../market-data/index/${indexName}/${year}/${month}/${date}.parquet`);
            secFilePath = path.join(__dirname, `../../../../market-data-1-sec/index/${indexName}/${year}/${month}/${date}.parquet`);
        } else {
            minFilePath = path.join(__dirname, `../../../../market-data/options/${indexName}/${year}/${month}/expiry=${expiry}/date=${date}/${strike}_${optionType}.parquet`);
            secFilePath = path.join(__dirname, `../../../../market-data-1-sec/options/${indexName}/${year}/${month}/expiry=${expiry}/date=${date}/${strike}_${optionType}.parquet`);
        }

        const minData = await this.readParquetFile(minFilePath);
        const secData = await this.readParquetFile(secFilePath);

        if (!secData || secData.length === 0) {
            console.log(`[DEBUG] No 1s data found for ${type} at ${secFilePath}`);
            return minData;
        }
        console.log(`[DEBUG] Loaded 1s data for ${type} from ${secFilePath}. Length: ${secData.length}`);

        const extract = type === 'index' ? this.extractTime.bind(this) : this.extractTimeOption.bind(this);
        
        const filteredMinData = minData.filter(row => {
            const timeStr = extract(row);
            return timeStr !== '09:15:00'; 
        });

        return [...secData, ...filteredMinData];
    }

    getStrikeStep(indexName) {
        return indexName === 'SENSEX' ? 100 : 50;
    }

    calculateATM(spotPrice, step) {
        return Math.round(spotPrice / step) * step;
    }

    async getValidOptionDataWithFallback(indexName, year, month, date, expiry, initialStrike, optionType, step, requiredTime = null, maxSteps = 5, fallbackDirection = 'ALTERNATE') {
        const checkData = async (strikeToTest) => {
            const data = await this.fetchStitchedData('options', indexName, year, month, date, expiry, strikeToTest, optionType);
            if (data && data.length > 0) {
                return data;
            }
            return null;
        };

        // Try initial
        let data = await checkData(initialStrike);
        if (data) return { strike: initialStrike, data };

        // Fallback loop
        for (let i = 1; i <= maxSteps; i++) {
            if (fallbackDirection === 'UP') {
                const strikeUp = initialStrike + (i * step);
                data = await checkData(strikeUp);
                if (data) return { strike: strikeUp, data };
            } else if (fallbackDirection === 'DOWN') {
                const strikeDown = initialStrike - (i * step);
                data = await checkData(strikeDown);
                if (data) return { strike: strikeDown, data };
            } else {
                // ALTERNATE
                const strikeUp = initialStrike + (i * step);
                data = await checkData(strikeUp);
                if (data) return { strike: strikeUp, data };

                const strikeDown = initialStrike - (i * step);
                data = await checkData(strikeDown);
                if (data) return { strike: strikeDown, data };
            }
        }

        return { strike: initialStrike, data: [] }; // Failed
    }

    async getOptionPriceAtTime(indexName, year, month, expiry, date, strike, optionType, timeStr) {
        const data = await this.fetchStitchedData('options', indexName, year, month, date, expiry, strike, optionType);
        if (!data || data.length === 0) return null;
        
        const row = data.find(r => this.extractTimeOption(r) === timeStr);
        if (row) return row[6]; // Open price is index 6
        return null;
    }

    async findClosestPremiumStrike(indexName, year, month, expiry, date, atmStrike, step, optionType, targetPremium, entryTime) {
        const { strike: validAtmStrike, data: validAtmData } = await this.getValidOptionDataWithFallback(indexName, year, month, date, expiry, atmStrike, optionType, step, entryTime, 5, 'ALTERNATE');
        
        let currentStrike = validAtmStrike;
        let currentPrice = null;
        if (validAtmData && validAtmData.length > 0) {
            let row = validAtmData.find(r => this.extractTimeOption(r) === entryTime);
            if (!row) {
                const validTimes = validAtmData.map(r => this.extractTimeOption(r)).filter(t => t && t >= entryTime).sort();
                if (validTimes.length > 0) {
                    row = validAtmData.find(r => this.extractTimeOption(r) === validTimes[0]);
                }
            }
            if (row) currentPrice = row[6];
        }
        
        if (currentPrice === null) return atmStrike; 

        let bestStrike = currentStrike;
        let minDiff = Math.abs(currentPrice - targetPremium);
        
        let direction = 1; 
        if (currentPrice > targetPremium) {
            direction = optionType === 'CE' ? 1 : -1;
        } else {
            direction = optionType === 'CE' ? -1 : 1;
        }

        for (let i = 1; i <= 20; i++) {
            const nextStrike = currentStrike + (direction * step);
            const nextPrice = await this.getOptionPriceAtTime(indexName, year, month, expiry, date, nextStrike, optionType, entryTime);
            
            if (nextPrice === null) break;
            
            const diff = Math.abs(nextPrice - targetPremium);
            
            if (diff < minDiff) {
                minDiff = diff;
                bestStrike = nextStrike;
            }
            
            if (diff > minDiff) break;
            
            currentStrike = nextStrike;
        }
        
        return bestStrike;
    }

    findClosestExpiry(indexName, dateStr) {
        const [year, month] = dateStr.split('-');
        const monthDir = path.join(__dirname, `../../../../market-data/options/${indexName}/${year}/${month}`);
        if (!fs.existsSync(monthDir)) return null;
        
        const expiries = fs.readdirSync(monthDir)
            .filter(dir => dir.startsWith('expiry='))
            .map(dir => dir.split('=')[1])
            .filter(exp => exp >= dateStr)
            .sort();
            
        return expiries.length > 0 ? expiries[0] : null;
    }

    async run() {
        if (!this.strategy) await this.init();
        
        const dates = this.generateDateRange(this.fromDate, this.toDate);
        const indexName = this.strategy.config.index;
        let entryTime = this.strategy.config.entry_time;
        if (entryTime && entryTime.length === 5) entryTime += ':00';
        else if (!entryTime) entryTime = '09:15:00';
        
        let exitTime = this.strategy.config.exit_time;
        if (exitTime && exitTime.length === 5) exitTime += ':00';
        else if (!exitTime) exitTime = '15:15:00';
        const step = this.getStrikeStep(indexName);
        
        for (const date of dates) {
            console.log(`[Backtest Engine] Simulating Day: ${date}`);
            const [year, month] = date.split('-');
            
            // 1. Read Index Data
            const indexData = await this.fetchStitchedData('index', indexName, year, month, date);
            
            if (indexData.length === 0) {
                console.log(`  -> No index data found. Skipping.`);
                continue;
            }
            
            const dayChart = {}; // { '24200_CE': [{ time, open, high, low, close, action }], ... }
            // 2. Find Index Open Price at Entry Time
            const indexEntryRow = indexData.find(row => this.extractTime(row) === entryTime);
            if (!indexEntryRow) {
                console.log(`  -> Entry time ${entryTime} not found in index data. Skipping.`);
                continue;
            }
            
            const indexChartMap = new Map();
            indexData.forEach(row => {
                const time = this.extractTime(row);
                if (time) indexChartMap.set(time, { close: row[0], high: row[3], low: row[4], open: row[5] });
            });

            const spotPrice = indexEntryRow[5]; // open price
            const atmStrike = this.calculateATM(spotPrice, step);
            console.log(`  -> ATM Strike at ${entryTime} (Spot: ${spotPrice}): ${atmStrike}`);
            
            // 3. Find Expiry
            const expiry = this.findClosestExpiry(indexName, date);
            if (!expiry) {
                console.log(`  -> No expiry found for ${date}. Skipping.`);
                continue;
            }
            
            let dailyPnL = 0;
            let dailyTradeValue = 0;
            
            const roundToTick = (price, tick = 0.05) => {
                if (price === null || price === undefined || isNaN(price)) return 0;
                return Number(Math.max(tick, Math.round(price / tick) * tick).toFixed(2));
            };
            
            const calculateSlPrice = (leg, entryPrice, isReentry) => {
                const isSlEnabled = isReentry && leg.reentry_sl_enabled ? true : leg.sl_enabled !== false;
                const activeSlType = isReentry && leg.reentry_sl_enabled ? (leg.reentry_sl_type || 'PERCENTAGE') : (leg.sl_type || 'PERCENTAGE');
                const activeSlValue = isReentry && leg.reentry_sl_enabled ? leg.reentry_sl_value : leg.stop_loss;
                
                if (isSlEnabled && parseFloat(activeSlValue) > 0) {
                    const slVal = parseFloat(activeSlValue);
                    if (activeSlType === 'POINTS') {
                        return roundToTick(leg.side === 'BUY' ? entryPrice - slVal : entryPrice + slVal);
                    } else {
                        return roundToTick(leg.side === 'BUY' ? entryPrice * (1 - slVal / 100) : entryPrice * (1 + slVal / 100));
                    }
                }
                return null;
            };

            // 4. Pre-load Option Data and calculate Entry Prices for all legs
            const activeLegs = [];
            const lotsize = indexName === 'NIFTY' ? 65 : (indexName === 'SENSEX' ? 20 : 1);
            const multiplier = 1; // Forced to 1 for backtesting. Multiplier is applied dynamically in the UI.

            for (const leg of this.strategy.config.legs) {
                const strikeStr = leg.strike || leg.strike_selection || "ATM";
                const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
                const type = match ? match[1] : "ATM";
                const offset = match && match[2] ? parseInt(match[2]) : 0;
                
                let targetStrike = atmStrike;
                if (leg.strike_criteria === 'CLOSEST_PREMIUM') {
                    const targetPremium = parseFloat(leg.premium) || 0;
                    targetStrike = await this.findClosestPremiumStrike(indexName, year, month, expiry, date, atmStrike, step, leg.option_type, targetPremium, entryTime);
                    console.log(`    -> Closest Premium for ₹${targetPremium} found at strike ${targetStrike}_${leg.option_type}`);
                } else if (type === "OTM") {
                    targetStrike = leg.option_type === "CE" ? atmStrike + (offset * step) : atmStrike - (offset * step);
                } else if (type === "ITM") {
                    targetStrike = leg.option_type === "CE" ? atmStrike - (offset * step) : atmStrike + (offset * step);
                }
                 
                
                let fallbackDir = 'ALTERNATE';
                if (type === 'OTM') {
                    fallbackDir = leg.option_type === 'CE' ? 'UP' : 'DOWN';
                } else if (type === 'ITM') {
                    fallbackDir = leg.option_type === 'CE' ? 'DOWN' : 'UP';
                }

                let { strike: finalTargetStrike, data: optionData } = await this.getValidOptionDataWithFallback(indexName, year, month, date, expiry, targetStrike, leg.option_type, step, entryTime, 5, fallbackDir);
                
                if (finalTargetStrike !== targetStrike) {
                    console.log(`    -> Fallback: Original strike ${targetStrike} missing data, using ${finalTargetStrike}_${leg.option_type}`);
                    targetStrike = finalTargetStrike;
                }

                if (!optionData || optionData.length === 0) {
                    console.log(`    -> Missing option data: ${targetStrike}_${leg.option_type}`);
                    continue;
                }
                
                const chartMap = new Map();
                const optionDayChart = optionData.map(row => {
                    const time = this.extractTimeOption(row);
                    const mapped = {
                        time, open: row[6], high: row[4], low: row[5], close: row[0], action: null
                    };
                    if (time) chartMap.set(time, mapped);
                    return mapped;
                });

                let actualEntryTime = entryTime;
                let entryNode = chartMap.get(actualEntryTime);
                if (!entryNode) {
                    const allKeys = Array.from(chartMap.keys()).sort();
                    const nextTime = allKeys.find(t => t >= entryTime);
                    if (nextTime) {
                        actualEntryTime = nextTime;
                        entryNode = chartMap.get(actualEntryTime);
                        console.log(`    -> Missing exact entry row at ${entryTime} for ${targetStrike}. Moved entry to ${actualEntryTime}`);
                    }
                }

                if (!entryNode) {
                    console.log(`    -> No entry row found >= ${entryTime} for ${targetStrike}_${leg.option_type}`);
                    continue;
                }

                const basePrice = entryNode.open;
                const qty = leg.lots * lotsize * multiplier;
                
                let initialState = 'ACTIVE';
                let initialTrades = [];
                let initialEntryPrice = null;
                let initialSlPrice = null;
                let initialTslRef = null;
                let mtp = null;
                
                if (leg.simple_mntm_enabled) {
                    initialState = 'WAITING_FOR_MNTM';
                    let mMode = leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT';
                    let mVal = parseFloat(leg.simple_mntm_value || 0);
                    
                    if (mMode.includes("PLUS_PCT")) mtp = basePrice + (basePrice * mVal / 100);
                    else if (mMode.includes("PLUS_PTS")) mtp = basePrice + mVal;
                    else if (mMode.includes("MINUS_PCT")) mtp = basePrice - (basePrice * mVal / 100);
                    else if (mMode.includes("MINUS_PTS")) mtp = basePrice - mVal;
                    
                    mtp = roundToTick(mtp);
                } else {
                    initialEntryPrice = basePrice;
                    dailyTradeValue += (initialEntryPrice * qty);
                    initialSlPrice = calculateSlPrice(leg, initialEntryPrice, false);
                    initialTslRef = initialEntryPrice;
                    initialTrades.push({
                        entryTime: actualEntryTime,
                        entryPrice: initialEntryPrice,
                        exitTime: null,
                        exitPrice: null,
                        exitReason: null,
                        tradePnL: 0,
                        tradeValue: initialEntryPrice * qty,
                        tradeSlPrice: initialSlPrice
                    });
                }

                activeLegs.push({
                    leg, targetStrike, qty, chartMap, optionDayChart, optionData,
                    state: initialState,
                    reentryCount: 0,
                    trades: initialTrades,
                    entryTime: initialState === 'ACTIVE' ? actualEntryTime : null, 
                    entryPrice: initialEntryPrice, 
                    slPrice: initialSlPrice, 
                    lockedPnL: 0,
                    rtp: null, mtp: mtp, tslReferencePrice: initialTslRef,
                    baseOtp: basePrice
                });
            }

            if (activeLegs.length === 0) continue;

            // 5. Minute-by-Minute Simulation to check Overall SL/Target
            let actualExitTime = exitTime;
            let exitReason = 'EXIT_TIME';

            // Generate sequence of minutes from entryTime to exitTime based on data from first leg
            const allTimes = Array.from(activeLegs[0].chartMap.keys()).filter(t => t >= entryTime && t <= exitTime).sort();

            const config = this.strategy.config;
            const slEnabled = config.overall_sl_enabled && parseFloat(config.overall_sl_value) > 0;
            const slVal = parseFloat(config.overall_sl_value) || 0;

            const targetEnabled = config.overall_target_enabled && parseFloat(config.overall_target_value) > 0;
            const targetVal = parseFloat(config.overall_target_value) || 0;

            const dailyOverallPnLChart = [];
            let exitAtOpen = false;

            for (const t of allTimes) {
                let currentOpenPnL = 0;
                let currentClosePnL = 0;
                for (const active of activeLegs) {
                    const node = active.chartMap.get(t);
                    if (!node) {
                        const fallbackPnL = active.lastMinutePnL !== undefined ? active.lastMinutePnL : active.lockedPnL;
                        currentOpenPnL += fallbackPnL;
                        currentClosePnL += fallbackPnL;
                        if (!active.minutePnLMap) active.minutePnLMap = new Map();
                        active.minutePnLMap.set(t, fallbackPnL);
                        active.lastMinutePnL = fallbackPnL;
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_MNTM') {
                        let mntmHit = false;
                        if (active.leg.simple_mntm_mode.includes("PLUS_")) {
                            if (node.high >= active.mtp) mntmHit = true;
                        } else {
                            if (node.low <= active.mtp) mntmHit = true;
                        }

                        if (mntmHit) {
                            active.state = 'ACTIVE';
                            active.entryTime = t;
                            active.entryPrice = active.mtp; // Execute exactly at mtp
                            active.slPrice = calculateSlPrice(active.leg, active.entryPrice, false);
                            active.tslReferencePrice = active.entryPrice;
                            
                            active.trades.push({
                                entryTime: active.entryTime, entryPrice: active.entryPrice,
                                exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                tradeSlPrice: active.slPrice
                            });
                            dailyTradeValue += (active.entryPrice * active.qty);

                            // Log Action
                            const idx = active.optionDayChart.findIndex(c => c.time === t);
                            if (idx !== -1) {
                                const slStr = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                const entrySide = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                const actionStr = `Entry (${entrySide}) [MNTM]: ${active.entryPrice.toFixed(2)}${slStr}`;
                                active.optionDayChart[idx].action = active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' + actionStr : actionStr;
                            }
                        }
                        // Fall through to evaluate TSL and SL on the exact entry minute
                    }



                    if (active.state === 'ACTIVE') {
                        let isEntryMinute = (t === active.entryTime);
                        let isReentered = active.reentryCount > 0;

                        // Determine if tsl_on_close mode is active for this leg
                        const tslOnClose = isReentered
                            ? (active.leg.reentry_tsl_on_close === true || (!active.leg.reentry_tsl_on_close && active.leg.tsl_on_close === true))
                            : (active.leg.tsl_on_close === true);

                        if (tslOnClose && t === active.entryTime) {
                            console.log(`  [TSL OnClose] Leg ${active.targetStrike}_${active.leg.option_type}: tsl_on_close mode ACTIVE. Trail will use close only.`);
                        }

                        let checkSL = true;
                        let trailReference = node.close;

                        if (tslOnClose) {
                            // On Close mode: always use close for both SL check and trail reference
                            trailReference = node.close;
                            if (isReentered && isEntryMinute) {
                                checkSL = false;
                            }
                        } else {
                            // Default mode: use high/low
                            if (!isReentered) {
                                checkSL = true;
                                trailReference = active.leg.side === 'SELL' ? node.low : node.high;
                            } else {
                                if (isEntryMinute) {
                                    checkSL = false;
                                    trailReference = node.close;
                                } else {
                                    checkSL = true;
                                    trailReference = active.leg.side === 'SELL' ? node.low : node.high;
                                }
                            }
                        }

                        // --- TSL On Close mode: Check SL FIRST, then trail ---
                        // --- Default mode: Trail FIRST, then check SL ---
                        const isTslEnabled = isReentered ? (active.leg.reentry_tsl_enabled === true) : active.leg.tsl_enabled;
                        let trailedInThisMinute = false;

                        if (tslOnClose) {
                            // 1. Check SL hit FIRST on high/low (before trailing)
                            let hitSL = false;
                            if (checkSL && active.slPrice !== null) {
                                if (active.leg.side === 'SELL' && node.high >= active.slPrice) hitSL = true;
                                if (active.leg.side === 'BUY' && node.low <= active.slPrice) hitSL = true;
                            }

                            if (hitSL) {
                                // SL hit on close — skip trailing, exit immediately
                                trailedInThisMinute = false;
                            } else {
                                // 2. SL not hit — now trail using close
                                if (isTslEnabled && active.tslReferencePrice !== undefined) {
                                    const tslType = isReentered ? (active.leg.reentry_tsl_type || "PERCENTAGE") : (active.leg.tsl_type || "PERCENTAGE");
                                    let tslMove = isReentered ? parseFloat(active.leg.reentry_tsl_move || 0) : parseFloat(active.leg.tsl_move || 0);
                                    let tslTrail = isReentered ? parseFloat(active.leg.reentry_tsl_trail || 0) : parseFloat(active.leg.tsl_trail || 0);
                                    
                                    if (isReentered && (isNaN(tslMove) || tslMove <= 0)) tslMove = parseFloat(active.leg.tsl_move || 0);
                                    if (isReentered && (isNaN(tslTrail) || tslTrail <= 0)) tslTrail = parseFloat(active.leg.tsl_trail || 0);

                                    if (!isNaN(tslMove) && !isNaN(tslTrail) && tslMove > 0 && tslTrail > 0) {
                                        let moveThreshold = tslMove;
                                        let trailAmount = tslTrail;

                                        if (tslType === "PERCENTAGE") {
                                            moveThreshold = active.entryPrice * (tslMove / 100);
                                            trailAmount = active.entryPrice * (tslTrail / 100);
                                        }

                                        let peakPrice = trailReference; // always close in this mode
                                        let favorableMove = active.leg.side === "BUY" ? (peakPrice - active.tslReferencePrice) : (active.tslReferencePrice - peakPrice);

                                        if (favorableMove >= moveThreshold) {
                                            const steps = Math.floor(favorableMove / moveThreshold);
                                            if (steps > 0) {
                                                if (active.leg.side === "BUY") {
                                                    active.slPrice = active.slPrice + (steps * trailAmount);
                                                    active.tslReferencePrice = active.tslReferencePrice + (steps * moveThreshold);
                                                } else {
                                                    active.slPrice = active.slPrice - (steps * trailAmount);
                                                    active.tslReferencePrice = active.tslReferencePrice - (steps * moveThreshold);
                                                }
                                                active.slPrice = roundToTick(active.slPrice);
                                                trailedInThisMinute = true;
                                                
                                                const idx = active.optionDayChart.findIndex(c => c.time === t);
                                                if (idx !== -1) {
                                                    const tslActionStr = `[TSL Trailed OnClose] New SL: ₹${active.slPrice.toFixed(2)}`;
                                                    active.optionDayChart[idx].action = active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' + tslActionStr : tslActionStr;
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Re-evaluate SL after trailing (in case trail moved SL into the close price)
                            // But since we already checked SL before trailing, hitSL stays as-is
                            // The hitSL variable from above is used below

                        } else {
                            // Default mode: Trail FIRST, then check SL

                            // 1. Evaluate Trailing Stop Loss FIRST (trail before checking SL hit)
                            if (isTslEnabled && active.tslReferencePrice !== undefined) {
                                const tslType = isReentered ? (active.leg.reentry_tsl_type || "PERCENTAGE") : (active.leg.tsl_type || "PERCENTAGE");
                                let tslMove = isReentered ? parseFloat(active.leg.reentry_tsl_move || 0) : parseFloat(active.leg.tsl_move || 0);
                                let tslTrail = isReentered ? parseFloat(active.leg.reentry_tsl_trail || 0) : parseFloat(active.leg.tsl_trail || 0);
                                
                                // fallback
                                if (isReentered && (isNaN(tslMove) || tslMove <= 0)) tslMove = parseFloat(active.leg.tsl_move || 0);
                                if (isReentered && (isNaN(tslTrail) || tslTrail <= 0)) tslTrail = parseFloat(active.leg.tsl_trail || 0);

                                if (!isNaN(tslMove) && !isNaN(tslTrail) && tslMove > 0 && tslTrail > 0) {
                                    let moveThreshold = tslMove;
                                    let trailAmount = tslTrail;

                                    if (tslType === "PERCENTAGE") {
                                        moveThreshold = active.entryPrice * (tslMove / 100);
                                        trailAmount = active.entryPrice * (tslTrail / 100);
                                    }

                                    let peakPrice = trailReference;
                                    let favorableMove = active.leg.side === "BUY" ? (peakPrice - active.tslReferencePrice) : (active.tslReferencePrice - peakPrice);

                                    if (favorableMove >= moveThreshold) {
                                        const steps = Math.floor(favorableMove / moveThreshold);
                                        if (steps > 0) {
                                            if (active.leg.side === "BUY") {
                                                active.slPrice = active.slPrice + (steps * trailAmount);
                                                active.tslReferencePrice = active.tslReferencePrice + (steps * moveThreshold);
                                            } else {
                                                active.slPrice = active.slPrice - (steps * trailAmount);
                                                active.tslReferencePrice = active.tslReferencePrice - (steps * moveThreshold);
                                            }
                                            active.slPrice = roundToTick(active.slPrice);
                                            trailedInThisMinute = true;
                                            
                                            // Log TSL Trailed action
                                            const idx = active.optionDayChart.findIndex(c => c.time === t);
                                            if (idx !== -1) {
                                                const tslActionStr = `[TSL Trailed] New SL: ₹${active.slPrice.toFixed(2)}`;
                                                active.optionDayChart[idx].action = active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' + tslActionStr : tslActionStr;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Final SL check (for default mode, or re-check for onClose mode)
                        let hitSL = false;
                        if (checkSL && active.slPrice !== null) {
                            if (tslOnClose) {
                                // On Close mode: SL check still on high/low
                                if (active.leg.side === 'SELL' && node.high >= active.slPrice) hitSL = true;
                                if (active.leg.side === 'BUY' && node.low <= active.slPrice) hitSL = true;
                            } else if (trailedInThisMinute) {
                                if (active.leg.side === 'SELL' && node.close >= active.slPrice) hitSL = true;
                                if (active.leg.side === 'BUY' && node.close <= active.slPrice) hitSL = true;
                            } else {
                                if (active.leg.side === 'SELL' && node.high >= active.slPrice) hitSL = true;
                                if (active.leg.side === 'BUY' && node.low <= active.slPrice) hitSL = true;
                            }
                        }

                        if (hitSL) {
                            active.state = 'STOPPED_OUT';
                            const exitTime = t;
                            const exitPrice = active.slPrice; // exited exactly at SL
                            const exitReason = 'LEG_SL';
                            const pnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - exitPrice) : (exitPrice - active.entryPrice);
                            const tradePnL = pnlDiff * active.qty;
                            const tradeValue = active.entryPrice * active.qty;
                            
                            const currentTrade = active.trades[active.trades.length - 1];
                            currentTrade.exitTime = exitTime;
                            currentTrade.exitPrice = exitPrice;
                            currentTrade.exitReason = exitReason;
                            currentTrade.tradePnL = tradePnL;
                            
                            active.slHitMinute = t;

                            active.lockedPnL += tradePnL;
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;

                            if (!active.minutePnLMap) active.minutePnLMap = new Map();
                            active.minutePnLMap.set(t, active.lockedPnL);

                            // Setup RE-COST or RE-SL if enabled
                            if (active.leg.recost_enabled && active.reentryCount < (parseInt(active.leg.max_reentry) || 1)) {
                                active.state = 'WAITING_FOR_RECOST_RTP';
                                
                                const mode = active.leg.recost_mode || "RECOST_PLUS_PCT";
                                const val = parseFloat(active.leg.recost_value || 0);
                                let rtp = active.baseOtp;

                                if (mode === "RECOST_PLUS_PCT") rtp = active.baseOtp + (active.baseOtp * val / 100);
                                else if (mode === "RECOST_PLUS_PTS") rtp = active.baseOtp + val;
                                else if (mode === "RECOST_MINUS_PCT") rtp = active.baseOtp - (active.baseOtp * val / 100);
                                else if (mode === "RECOST_MINUS_PTS") rtp = active.baseOtp - val;

                                active.rtp = roundToTick(rtp);
                                active.recostWaitDirection = active.slPrice > active.rtp ? 'DOWN' : 'UP';
                                currentTrade.reentryCalcStr = `Calc RTP: ₹${active.rtp.toFixed(2)}`;

                                if (active.leg.recost_mntm_enabled) {
                                    const mntmMode = active.leg.recost_mntm_mode || "RECOST_PLUS_PCT";
                                    const mntmVal = parseFloat(active.leg.recost_mntm_value || 0);
                                    let mtp = active.rtp;

                                    if (mntmMode === "RECOST_PLUS_PCT") mtp = active.rtp + (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "RECOST_PLUS_PTS") mtp = active.rtp + mntmVal;
                                    else if (mntmMode === "RECOST_MINUS_PCT") mtp = active.rtp - (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "RECOST_MINUS_PTS") mtp = active.rtp - mntmVal;

                                    active.mtp = roundToTick(mtp);
                                    currentTrade.reentryCalcStr += ` | Calc MTP: ₹${active.mtp.toFixed(2)}`;
                                } else {
                                    active.mtp = null;
                                }

                                const closePrice = node.close;
                                let rtpCrossed = false;
                                if (active.recostWaitDirection === 'DOWN') {
                                    if (closePrice <= active.rtp) rtpCrossed = true;
                                } else {
                                    if (closePrice >= active.rtp) rtpCrossed = true;
                                }

                                if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                                    if (active.mtp !== null && active.mtp !== active.rtp) {
                                        active.state = 'WAITING_FOR_RECOST_MTP';
                                        if (node.time) {
                                            const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                            if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                        }
                                    } else {
                                        active.state = 'ACTIVE';
                                        active.reentryCount++;
                                        active.entryTime = t;
                                        active.entryPrice = active.mtp !== null ? active.mtp : active.rtp; 
                                        
                                        active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                        active.tslReferencePrice = active.entryPrice;

                                        active.trades.push({
                                            entryTime: active.entryTime, entryPrice: active.entryPrice,
                                            exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                            tradeSlPrice: active.slPrice
                                        });
                                        dailyTradeValue += (active.entryPrice * active.qty);
                                        
                                        const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                        if (idxLog !== -1) {
                                            const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                            const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                            const actionStrLog = `Re-Entry (${entrySideLog}) [RE-COST]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                            active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                        }
                                        const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                                        const newTradeOpenPnL = openPnlDiff * active.qty;
                                        const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                        const newTradeClosePnL = closePnlDiff * active.qty;
                                        
                                        currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                        currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                        active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                                    }
                                }
                            } else if (active.leg.resl_enabled && active.reentryCount < (parseInt(active.leg.max_reentry) || 1)) {
                                if (active.reentryCount === 0 || active.reslRtpLocked === undefined) {
                                    const slMode = active.leg.resl_mode || "RESL_PLUS_PCT";
                                    const slValue = parseFloat(active.leg.resl_value || 0);
                                    let reslTarget = active.slPrice;
                                    if (slMode === "RESL_PLUS_PCT") reslTarget = reslTarget + (reslTarget * slValue / 100);
                                    else if (slMode === "RESL_PLUS_PTS") reslTarget = reslTarget + slValue;
                                    else if (slMode === "RESL_MINUS_PCT") reslTarget = reslTarget - (reslTarget * slValue / 100);
                                    else if (slMode === "RESL_MINUS_PTS") reslTarget = reslTarget - slValue;
                                    
                                    active.reslRtpLocked = roundToTick(reslTarget);
                                    
                                    if (active.leg.resl_mntm_enabled) {
                                        const mntmMode = active.leg.resl_mntm_mode || "RESL_PLUS_PCT";
                                        const mntmValue = parseFloat(active.leg.resl_mntm_value || 0);
                                        let mntmTarget = active.reslRtpLocked;
                                        if (mntmMode.includes("PLUS_PCT") || mntmMode === "PERCENTAGE") mntmTarget += (mntmTarget * mntmValue / 100);
                                        else if (mntmMode.includes("PLUS_PTS") || mntmMode === "POINTS") mntmTarget += mntmValue;
                                        else if (mntmMode.includes("MINUS_PCT")) mntmTarget -= (mntmTarget * mntmValue / 100);
                                        else if (mntmMode.includes("MINUS_PTS")) mntmTarget -= mntmValue;
                                        active.reslMtpLocked = roundToTick(mntmTarget);
                                    } else {
                                        active.reslMtpLocked = null;
                                    }
                                }

                                active.rtp = active.reslRtpLocked;
                                active.mtp = active.reslMtpLocked;
                                active.state = 'WAITING_FOR_RESL_RTP';
                                currentTrade.reentryCalcStr = `Calc RTP: ₹${active.rtp.toFixed(2)}`;
                                if (active.mtp !== null) {
                                    currentTrade.reentryCalcStr += ` | Calc MTP: ₹${active.mtp.toFixed(2)}`;
                                }

                                active.reslWaitDirection = active.slPrice > active.rtp ? 'DOWN' : 'UP';

                                const closePrice = node.close;
                                let rtpCrossed = false;
                                if (active.reslWaitDirection === 'DOWN') {
                                    if (closePrice <= active.rtp) rtpCrossed = true;
                                } else {
                                    if (closePrice >= active.rtp) rtpCrossed = true;
                                }

                                if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                                    if (active.mtp) {
                                        active.state = 'WAITING_FOR_RESL_MTP';
                                        if (node.time) {
                                            const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                            if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                        }
                                    } else {
                                        active.state = 'ACTIVE';
                                        active.reentryCount++;
                                        active.entryTime = t;
                                        active.entryPrice = active.rtp;
                                        
                                        active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                        active.tslReferencePrice = active.entryPrice;

                                        active.trades.push({
                                            entryTime: active.entryTime, entryPrice: active.entryPrice,
                                            exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                            tradeSlPrice: active.slPrice
                                        });
                                        dailyTradeValue += (active.entryPrice * active.qty);
                                        
                                        const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                        if (idxLog !== -1) {
                                            const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                            const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                            const actionStrLog = `Re-Entry (${entrySideLog}) [RE-SL]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                            active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                        }
                                        const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                        const newTradePnL = closePnlDiff * active.qty;
                                        active.minutePnLMap.set(t, active.lockedPnL + newTradePnL);
                                        currentClosePnL += active.lockedPnL + newTradePnL;
                                    }
                                }
                            } else if (active.leg.rehigh_enabled && active.reentryCount < (parseInt(active.leg.max_reentry) || 1)) {
                                active.rehighPeak = exitPrice;
                                if (node.close > active.rehighPeak) {
                                    active.rehighPeak = node.close;
                                }
                                active.state = 'WAITING_FOR_REHIGH_RTP';

                                const mode = active.leg.rehigh_mode || "REHIGH_MINUS_PTS";
                                const val = parseFloat(active.leg.rehigh_value || 0);
                                let rtp = active.rehighPeak;
                                if (mode === "REHIGH_MINUS_PCT") rtp = active.rehighPeak - (active.rehighPeak * val / 100);
                                else if (mode === "REHIGH_MINUS_PTS") rtp = active.rehighPeak - val;
                                active.rtp = roundToTick(rtp);

                                if (active.leg.rehigh_mntm_enabled) {
                                    const mntmMode = active.leg.rehigh_mntm_mode || "REHIGH_PLUS_PCT";
                                    const mntmVal = parseFloat(active.leg.rehigh_mntm_value || 0);
                                    let mtp = active.rtp;
                                    if (mntmMode === "REHIGH_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = active.rtp + (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "REHIGH_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = active.rtp + mntmVal;
                                    else if (mntmMode === "REHIGH_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = active.rtp - (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "REHIGH_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = active.rtp - mntmVal;
                                    active.mtp = roundToTick(mtp);
                                } else {
                                    active.mtp = null;
                                }

                                currentTrade.reentryCalcStr = `Calc RTP: ₹${active.rtp.toFixed(2)}`;
                                if (active.mtp !== null) {
                                    currentTrade.reentryCalcStr += ` | Calc MTP: ₹${active.mtp.toFixed(2)}`;
                                }

                                const idxLogInit = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLogInit !== -1) {
                                    let logStr = `[RE-HIGH] Initial Peak: ₹${active.rehighPeak.toFixed(2)} | RTP: ₹${active.rtp.toFixed(2)}`;
                                    if (active.mtp !== null) logStr += ` | MTP: ₹${active.mtp.toFixed(2)}`;
                                    active.optionDayChart[idxLogInit].action = active.optionDayChart[idxLogInit].action ? active.optionDayChart[idxLogInit].action + ' | ' + logStr : logStr;
                                }

                                let rtpCrossed = false;
                                if (active.rtp <= active.rehighPeak && active.rtp >= node.close) {
                                    rtpCrossed = true;
                                }

                                if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                                    if (active.mtp) {
                                        active.state = 'WAITING_FOR_REHIGH_MTP';
                                        if (node.time) {
                                            const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                            if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                        }
                                    } else {
                                        active.state = 'ACTIVE';
                                        active.reentryCount++;
                                        active.entryTime = t;
                                        active.entryPrice = active.rtp;
                                        
                                        active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                        active.tslReferencePrice = active.entryPrice;

                                        active.trades.push({
                                            entryTime: active.entryTime, entryPrice: active.entryPrice,
                                            exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                            tradeSlPrice: active.slPrice
                                        });
                                        dailyTradeValue += (active.entryPrice * active.qty);
                                        
                                        const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                        if (idxLog !== -1) {
                                            const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                            const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                            const actionStrLog = `Re-Entry (${entrySideLog}) [RE-HIGH]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                            active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                        }
                                        const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                        const newTradePnL = closePnlDiff * active.qty;
                                        active.minutePnLMap.set(t, active.lockedPnL + newTradePnL);
                                        currentClosePnL += active.lockedPnL + newTradePnL;
                                    }
                                }
                            } else if (active.leg.relow_enabled && active.reentryCount < (parseInt(active.leg.max_reentry) || 1)) {
                                active.relowLow = exitPrice;
                                if (node.close < active.relowLow) {
                                    active.relowLow = node.close;
                                }
                                active.state = 'WAITING_FOR_RELOW_RTP';

                                const mode = active.leg.relow_mode || "RELOW_PLUS_PTS";
                                const val = parseFloat(active.leg.relow_value || 0);
                                let rtp = active.relowLow;
                                if (mode === "RELOW_PLUS_PCT") rtp = active.relowLow + (active.relowLow * val / 100);
                                else if (mode === "RELOW_PLUS_PTS") rtp = active.relowLow + val;
                                active.rtp = roundToTick(rtp);

                                if (active.leg.relow_mntm_enabled) {
                                    const mntmMode = active.leg.relow_mntm_mode || "RELOW_PLUS_PCT";
                                    const mntmVal = parseFloat(active.leg.relow_mntm_value || 0);
                                    let mtp = active.rtp;
                                    if (mntmMode === "RELOW_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = active.rtp + (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "RELOW_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = active.rtp + mntmVal;
                                    else if (mntmMode === "RELOW_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = active.rtp - (active.rtp * mntmVal / 100);
                                    else if (mntmMode === "RELOW_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = active.rtp - mntmVal;
                                    active.mtp = roundToTick(mtp);
                                } else {
                                    active.mtp = null;
                                }

                                currentTrade.reentryCalcStr = `Calc RTP: ₹${active.rtp.toFixed(2)}`;
                                if (active.mtp !== null) {
                                    currentTrade.reentryCalcStr += ` | Calc MTP: ₹${active.mtp.toFixed(2)}`;
                                }

                                const idxLogInit = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLogInit !== -1) {
                                    let logStr = `[RE-LOW] Initial Low: ₹${active.relowLow.toFixed(2)} | RTP: ₹${active.rtp.toFixed(2)}`;
                                    if (active.mtp !== null) logStr += ` | MTP: ₹${active.mtp.toFixed(2)}`;
                                    active.optionDayChart[idxLogInit].action = active.optionDayChart[idxLogInit].action ? active.optionDayChart[idxLogInit].action + ' | ' + logStr : logStr;
                                }

                                let rtpCrossed = false;
                                if (active.rtp >= active.relowLow && active.rtp <= node.close) {
                                    rtpCrossed = true;
                                }

                                if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                                    if (active.mtp) {
                                        active.state = 'WAITING_FOR_RELOW_MTP';
                                        if (node.time) {
                                            const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                            if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                        }
                                    } else {
                                        active.state = 'ACTIVE';
                                        active.reentryCount++;
                                        active.entryTime = t;
                                        active.entryPrice = active.rtp;
                                        
                                        active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                        active.tslReferencePrice = active.entryPrice;

                                        active.trades.push({
                                            entryTime: active.entryTime, entryPrice: active.entryPrice,
                                            exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                            tradeSlPrice: active.slPrice
                                        });
                                        dailyTradeValue += (active.entryPrice * active.qty);
                                        
                                        const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                        if (idxLog !== -1) {
                                            const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                            const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                            const actionStrLog = `Re-Entry (${entrySideLog}) [RE-LOW]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                            active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                        }
                                        const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                        const newTradePnL = closePnlDiff * active.qty;
                                        active.minutePnLMap.set(t, active.lockedPnL + newTradePnL);
                                        currentClosePnL += active.lockedPnL + newTradePnL;
                                    }
                                }
                            } else if (active.leg.re_asap_enabled && active.reentryCount < (parseInt(active.leg.re_asap_max_entries) || 1)) {
                                active.state = 'WAITING_FOR_RE_ASAP';
                                const indexRow = indexChartMap.get(t);
                                if (indexRow) {
                                    const closeSpot = indexRow.close;
                                    const newAtmStrike = this.calculateATM(closeSpot, step);
                                    
                                    const strikeStr = active.leg.strike || active.leg.strike_selection || "ATM";
                                    const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
                                    const type = match ? match[1] : "ATM";
                                    const offset = match && match[2] ? parseInt(match[2]) : 0;
                                    
                                    let newTargetStrike = newAtmStrike;
                                    if (active.leg.strike_criteria === 'CLOSEST_PREMIUM') {
                                        const targetPremium = parseFloat(active.leg.premium) || 0;
                                        newTargetStrike = await this.findClosestPremiumStrike(indexName, year, month, expiry, date, newAtmStrike, step, active.leg.option_type, targetPremium, t);
                                        console.log(`    -> [RE-ASAP] Closest Premium for ₹${targetPremium} found at strike ${newTargetStrike}_${active.leg.option_type}`);
                                    } else if (type === "OTM") {
                                        newTargetStrike = active.leg.option_type === "CE" ? newAtmStrike + (offset * step) : newAtmStrike - (offset * step);
                                    } else if (type === "ITM") {
                                        newTargetStrike = active.leg.option_type === "CE" ? newAtmStrike - (offset * step) : newAtmStrike + (offset * step);
                                    }
                                    active.asapNextStrike = newTargetStrike;
                                    
                                    const currentTrade = active.trades[active.trades.length - 1];
                                    currentTrade.reentryCalcStr = `Spot: ${closeSpot.toFixed(2)} | Target Strike: ${newTargetStrike}_${active.leg.option_type}`;
                                    
                                    const idxLogInit = active.optionDayChart.findIndex(c => c.time === t);
                                    if (idxLogInit !== -1) {
                                        const logStr = `[RE-ASAP] Prepared Re-entry Strike: ${newTargetStrike}_${active.leg.option_type}`;
                                        active.optionDayChart[idxLogInit].action = active.optionDayChart[idxLogInit].action ? active.optionDayChart[idxLogInit].action + ' | ' + logStr : logStr;
                                    }
                                }
                            } else if (active.leg.lazy_leg_enabled && active.leg.lazy_leg) {
                                active.state = 'WAITING_FOR_LAZY';
                                active.lazyLegConfig = { ...active.leg.lazy_leg };
                                const currentTrade = active.trades[active.trades.length - 1];
                                
                                let lazyTargetStrikeStr = '';
                                const indexRow = indexChartMap.get(t);
                                if (indexRow) {
                                    const closeSpot = indexRow.close;
                                    const newAtmStrike = this.calculateATM(closeSpot, step);
                                    
                                    const strikeStr = active.lazyLegConfig.strike || active.lazyLegConfig.strike_selection || "ATM";
                                    const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
                                    const type = match ? match[1] : "ATM";
                                    const offset = match && match[2] ? parseInt(match[2]) : 0;
                                    
                                    let newTargetStrike = newAtmStrike;
                                    if (active.lazyLegConfig.strike_criteria === 'CLOSEST_PREMIUM') {
                                        const targetPremium = parseFloat(active.lazyLegConfig.premium) || 0;
                                        newTargetStrike = await this.findClosestPremiumStrike(indexName, year, month, expiry, date, newAtmStrike, step, active.lazyLegConfig.option_type, targetPremium, t);
                                        console.log(`    -> [LAZY LEG] Closest Premium for ₹${targetPremium} found at strike ${newTargetStrike}_${active.lazyLegConfig.option_type}`);
                                    } else if (type === "OTM") {
                                        newTargetStrike = active.lazyLegConfig.option_type === "CE" ? newAtmStrike + (offset * step) : newAtmStrike - (offset * step);
                                    } else if (type === "ITM") {
                                        newTargetStrike = active.lazyLegConfig.option_type === "CE" ? newAtmStrike - (offset * step) : newAtmStrike + (offset * step);
                                    }
                                    
                                    active.lazyNextStrike = newTargetStrike;
                                    lazyTargetStrikeStr = `${newTargetStrike}_${active.lazyLegConfig.option_type}`;
                                    currentTrade.reentryCalcStr = `Spot: ${closeSpot.toFixed(2)} | Target Strike: ${lazyTargetStrikeStr}`;
                                } else {
                                    currentTrade.reentryCalcStr = `Prepared Lazy Leg: ${active.lazyLegConfig.option_type}`;
                                }
                                
                                const idxLogInit = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLogInit !== -1) {
                                    const logStr = lazyTargetStrikeStr ? `[LAZY LEG] Triggered Lazy Leg: ${lazyTargetStrikeStr}` : `[LAZY LEG] Triggered Lazy Leg: ${active.lazyLegConfig.option_type}`;
                                    active.optionDayChart[idxLogInit].action = active.optionDayChart[idxLogInit].action ? active.optionDayChart[idxLogInit].action + ' | ' + logStr : logStr;
                                }
                            }
                            continue;
                        }

                    }

                    if (active.state === 'WAITING_FOR_RECOST_RTP') {
                        const high = node.high;
                        const low = node.low;
                        let rtpCrossed = false;
                        
                        if (active.recostWaitDirection === 'DOWN') {
                            if (low <= active.rtp) rtpCrossed = true;
                        } else {
                            if (high >= active.rtp) rtpCrossed = true;
                        }

                        if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            if (active.mtp !== null && active.mtp !== active.rtp) {
                                active.state = 'WAITING_FOR_RECOST_MTP';
                                if (node.time) {
                                    const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                    if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                }
                                currentOpenPnL += active.lockedPnL;
                                currentClosePnL += active.lockedPnL;
                                active.minutePnLMap.set(t, active.lockedPnL);
                            } else {
                                active.state = 'ACTIVE';
                                active.reentryCount++;
                                active.entryTime = t;
                                active.entryPrice = active.mtp !== null ? active.mtp : active.rtp; 
                                
                                active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                active.tslReferencePrice = active.entryPrice;

                                active.trades.push({
                                    entryTime: active.entryTime, entryPrice: active.entryPrice,
                                    exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                    tradeSlPrice: active.slPrice
                                });
                                dailyTradeValue += (active.entryPrice * active.qty);
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                    const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                    const actionStrLog = `Re-Entry (${entrySideLog}) [RE-COST]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                    active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                }
                                const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                                const newTradeOpenPnL = openPnlDiff * active.qty;
                                const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                const newTradeClosePnL = closePnlDiff * active.qty;
                                
                                currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                            }
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_RECOST_MTP') {
                        const high = node.high;
                        const low = node.low;
                        let mtpCrossed = false;
                        
                        if (active.mtp > active.rtp) { 
                            if (high >= active.mtp) mtpCrossed = true;
                        } else {
                            if (low <= active.mtp) mtpCrossed = true;
                        }

                        if (mtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            active.state = 'ACTIVE';
                            active.reentryCount++;
                            active.entryTime = t;
                            active.entryPrice = active.mtp;
                            
                            active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                            active.tslReferencePrice = active.entryPrice;

                            active.trades.push({
                                entryTime: active.entryTime, entryPrice: active.entryPrice,
                                exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                tradeSlPrice: active.slPrice
                            });
                            dailyTradeValue += (active.entryPrice * active.qty);
                            
                            const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLog !== -1) {
                                const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                const actionStrLog = `Re-Entry (${entrySideLog}) [RE-COST]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                            }
                            const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                            const newTradeOpenPnL = openPnlDiff * active.qty;
                            const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                            const newTradeClosePnL = closePnlDiff * active.qty;
                            
                            currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                            currentClosePnL += active.lockedPnL + newTradeClosePnL;
                            active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_RESL_RTP') {
                        const high = node.high;
                        const low = node.low;
                        let rtpCrossed = false;
                        if (active.reslWaitDirection === 'DOWN') {
                            if (low <= active.rtp) rtpCrossed = true;
                        } else {
                            if (high >= active.rtp) rtpCrossed = true;
                        }

                        if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            if (active.mtp) {
                                active.state = 'WAITING_FOR_RESL_MTP';
                                if (node.time) {
                                    const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                    if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                }
                                currentOpenPnL += active.lockedPnL;
                                currentClosePnL += active.lockedPnL;
                                active.minutePnLMap.set(t, active.lockedPnL);
                            } else {
                                active.state = 'ACTIVE';
                                active.reentryCount++;
                                active.entryTime = t;
                                active.entryPrice = active.rtp; 
                                
                                active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                active.tslReferencePrice = active.entryPrice;

                                active.trades.push({
                                    entryTime: active.entryTime, entryPrice: active.entryPrice,
                                    exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                    tradeSlPrice: active.slPrice
                                });
                                dailyTradeValue += (active.entryPrice * active.qty);
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                    const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                    const actionStrLog = `Re-Entry (${entrySideLog}) [RE-SL]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                    active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                }
                                const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                                const newTradeOpenPnL = openPnlDiff * active.qty;
                                const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                const newTradeClosePnL = closePnlDiff * active.qty;
                                
                                currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                            }
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (!active.minutePnLMap) active.minutePnLMap = new Map();

                    if (active.state === 'WAITING_FOR_RESL_MTP') {
                        const high = node.high;
                        const low = node.low;
                        let mtpCrossed = false;
                        
                        if (active.mtp > active.rtp) { 
                            if (high >= active.mtp) mtpCrossed = true;
                        } else {
                            if (low <= active.mtp) mtpCrossed = true;
                        }

                        if (mtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            active.state = 'ACTIVE';
                            active.reentryCount++;
                            active.entryTime = t;
                            active.entryPrice = active.mtp;
                            
                            active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                            active.tslReferencePrice = active.entryPrice;

                            active.trades.push({
                                entryTime: active.entryTime, entryPrice: active.entryPrice,
                                exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                tradeSlPrice: active.slPrice
                            });
                            dailyTradeValue += (active.entryPrice * active.qty);
                            
                            const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLog !== -1) {
                                const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                const actionStrLog = `Re-Entry (${entrySideLog}) [RE-SL]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                            }
                            const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                            const newTradeOpenPnL = openPnlDiff * active.qty;
                            const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                            const newTradeClosePnL = closePnlDiff * active.qty;
                            
                            currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                            currentClosePnL += active.lockedPnL + newTradeClosePnL;
                            active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'STOPPED_OUT') {
                        currentOpenPnL += active.lockedPnL;
                        currentClosePnL += active.lockedPnL;
                        active.minutePnLMap.set(t, active.lockedPnL);
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_REHIGH_RTP') {
                        let newPeakFormed = false;
                        if (node.high > active.rehighPeak) {
                            active.rehighPeak = node.high;
                            newPeakFormed = true;
                            
                            const mode = active.leg.rehigh_mode || "REHIGH_MINUS_PTS";
                            const val = parseFloat(active.leg.rehigh_value || 0);
                            let rtp = active.rehighPeak;
                            if (mode === "REHIGH_MINUS_PCT") rtp = active.rehighPeak - (active.rehighPeak * val / 100);
                            else if (mode === "REHIGH_MINUS_PTS") rtp = active.rehighPeak - val;
                            active.rtp = roundToTick(rtp);

                            if (active.leg.rehigh_mntm_enabled) {
                                const mntmMode = active.leg.rehigh_mntm_mode || "REHIGH_PLUS_PCT";
                                const mntmVal = parseFloat(active.leg.rehigh_mntm_value || 0);
                                let mtp = active.rtp;
                                if (mntmMode === "REHIGH_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = active.rtp + (active.rtp * mntmVal / 100);
                                else if (mntmMode === "REHIGH_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = active.rtp + mntmVal;
                                else if (mntmMode === "REHIGH_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = active.rtp - (active.rtp * mntmVal / 100);
                                else if (mntmMode === "REHIGH_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = active.rtp - mntmVal;
                                active.mtp = roundToTick(mtp);
                            }

                            const idxLogUpdate = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLogUpdate !== -1) {
                                let logStr = `[RE-HIGH] New Peak: ₹${active.rehighPeak.toFixed(2)} | RTP: ₹${active.rtp.toFixed(2)}`;
                                if (active.mtp !== null) logStr += ` | MTP: ₹${active.mtp.toFixed(2)}`;
                                active.optionDayChart[idxLogUpdate].action = active.optionDayChart[idxLogUpdate].action ? active.optionDayChart[idxLogUpdate].action + ' | ' + logStr : logStr;
                            }
                        }

                        let rtpCrossed = false;
                        if (newPeakFormed) {
                            if (active.rtp >= node.close) {
                                rtpCrossed = true;
                            }
                        } else {
                            if (node.low <= active.rtp) {
                                rtpCrossed = true;
                            }
                        }

                        if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            if (active.mtp) {
                                active.state = 'WAITING_FOR_REHIGH_MTP';
                                if (node.time) {
                                    const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                    if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                }
                                currentOpenPnL += active.lockedPnL;
                                currentClosePnL += active.lockedPnL;
                                active.minutePnLMap.set(t, active.lockedPnL);
                            } else {
                                active.state = 'ACTIVE';
                                active.reentryCount++;
                                active.entryTime = t;
                                active.entryPrice = active.rtp; 
                                
                                active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                active.tslReferencePrice = active.entryPrice;

                                active.trades.push({
                                    entryTime: active.entryTime, entryPrice: active.entryPrice,
                                    exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                    tradeSlPrice: active.slPrice
                                });
                                dailyTradeValue += (active.entryPrice * active.qty);
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                    const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                    const actionStrLog = `Re-Entry (${entrySideLog}) [RE-HIGH]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                    active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                }
                                const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                                const newTradeOpenPnL = openPnlDiff * active.qty;
                                const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                const newTradeClosePnL = closePnlDiff * active.qty;
                                
                                currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                            }
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_REHIGH_MTP') {
                        let mtpCrossed = false;
                        if (active.mtp > active.rtp) { 
                            if (node.high >= active.mtp) mtpCrossed = true;
                        } else {
                            if (node.low <= active.mtp) mtpCrossed = true;
                        }

                        if (mtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            active.state = 'ACTIVE';
                            active.reentryCount++;
                            active.entryTime = t;
                            active.entryPrice = active.mtp;
                            
                            active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                            active.tslReferencePrice = active.entryPrice;

                            active.trades.push({
                                entryTime: active.entryTime, entryPrice: active.entryPrice,
                                exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                tradeSlPrice: active.slPrice
                            });
                            dailyTradeValue += (active.entryPrice * active.qty);
                            
                            const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLog !== -1) {
                                const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                const actionStrLog = `Re-Entry (${entrySideLog}) [RE-HIGH]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                            }
                            const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                            const newTradeOpenPnL = openPnlDiff * active.qty;
                            const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                            const newTradeClosePnL = closePnlDiff * active.qty;
                            
                            currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                            currentClosePnL += active.lockedPnL + newTradeClosePnL;
                            active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_RELOW_RTP') {
                        let newLowFormed = false;
                        if (node.low < active.relowLow) {
                            active.relowLow = node.low;
                            newLowFormed = true;
                            
                            const mode = active.leg.relow_mode || "RELOW_PLUS_PTS";
                            const val = parseFloat(active.leg.relow_value || 0);
                            let rtp = active.relowLow;
                            if (mode === "RELOW_PLUS_PCT") rtp = active.relowLow + (active.relowLow * val / 100);
                            else if (mode === "RELOW_PLUS_PTS") rtp = active.relowLow + val;
                            active.rtp = roundToTick(rtp);

                            if (active.leg.relow_mntm_enabled) {
                                const mntmMode = active.leg.relow_mntm_mode || "RELOW_PLUS_PCT";
                                const mntmVal = parseFloat(active.leg.relow_mntm_value || 0);
                                let mtp = active.rtp;
                                if (mntmMode === "RELOW_PLUS_PCT" || mntmMode === "PLUS_PCT" || mntmMode === "PERCENTAGE") mtp = active.rtp + (active.rtp * mntmVal / 100);
                                else if (mntmMode === "RELOW_PLUS_PTS" || mntmMode === "PLUS_PTS" || mntmMode === "POINTS") mtp = active.rtp + mntmVal;
                                else if (mntmMode === "RELOW_MINUS_PCT" || mntmMode === "MINUS_PCT") mtp = active.rtp - (active.rtp * mntmVal / 100);
                                else if (mntmMode === "RELOW_MINUS_PTS" || mntmMode === "MINUS_PTS") mtp = active.rtp - mntmVal;
                                active.mtp = roundToTick(mtp);
                            }

                            const idxLogUpdate = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLogUpdate !== -1) {
                                let logStr = `[RE-LOW] New Low: ₹${active.relowLow.toFixed(2)} | RTP: ₹${active.rtp.toFixed(2)}`;
                                if (active.mtp !== null) logStr += ` | MTP: ₹${active.mtp.toFixed(2)}`;
                                active.optionDayChart[idxLogUpdate].action = active.optionDayChart[idxLogUpdate].action ? active.optionDayChart[idxLogUpdate].action + ' | ' + logStr : logStr;
                            }
                        }

                        let rtpCrossed = false;
                        if (newLowFormed) {
                            if (active.rtp <= node.close) {
                                rtpCrossed = true;
                            }
                        } else {
                            if (node.high >= active.rtp) {
                                rtpCrossed = true;
                            }
                        }

                        if (rtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            if (active.mtp) {
                                active.state = 'WAITING_FOR_RELOW_MTP';
                                if (node.time) {
                                    const idx = active.optionDayChart.findIndex(c => c.time === node.time);
                                    if (idx !== -1) active.optionDayChart[idx].action = (active.optionDayChart[idx].action ? active.optionDayChart[idx].action + ' | ' : '') + `[RTP Hit] Waiting MTP: ₹${active.mtp.toFixed(2)}`;
                                }
                                currentOpenPnL += active.lockedPnL;
                                currentClosePnL += active.lockedPnL;
                                active.minutePnLMap.set(t, active.lockedPnL);
                            } else {
                                active.state = 'ACTIVE';
                                active.reentryCount++;
                                active.entryTime = t;
                                active.entryPrice = active.rtp; 
                                
                                active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                active.tslReferencePrice = active.entryPrice;

                                active.trades.push({
                                    entryTime: active.entryTime, entryPrice: active.entryPrice,
                                    exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                    tradeSlPrice: active.slPrice
                                });
                                dailyTradeValue += (active.entryPrice * active.qty);
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                    const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                    const actionStrLog = `Re-Entry (${entrySideLog}) [RE-LOW]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                    active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                }
                                const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                                const newTradeOpenPnL = openPnlDiff * active.qty;
                                const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                                const newTradeClosePnL = closePnlDiff * active.qty;
                                
                                currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                            }
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_RELOW_MTP') {
                        let mtpCrossed = false;
                        if (active.mtp < active.rtp) { 
                            if (node.low <= active.mtp) mtpCrossed = true;
                        } else {
                            if (node.high >= active.mtp) mtpCrossed = true;
                        }

                        if (mtpCrossed && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                            active.state = 'ACTIVE';
                            active.reentryCount++;
                            active.entryTime = t;
                            active.entryPrice = active.mtp;
                            
                            active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                            active.tslReferencePrice = active.entryPrice;

                            active.trades.push({
                                entryTime: active.entryTime, entryPrice: active.entryPrice,
                                exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                tradeSlPrice: active.slPrice
                            });
                            dailyTradeValue += (active.entryPrice * active.qty);
                            
                            const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                            if (idxLog !== -1) {
                                const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                const actionStrLog = `Re-Entry (${entrySideLog}) [RE-LOW]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                            }
                            const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.open) : (node.open - active.entryPrice);
                            const newTradeOpenPnL = openPnlDiff * active.qty;
                            const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - node.close) : (node.close - active.entryPrice);
                            const newTradeClosePnL = closePnlDiff * active.qty;
                            
                            currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                            currentClosePnL += active.lockedPnL + newTradeClosePnL;
                            active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                        } else {
                            currentOpenPnL += active.lockedPnL;
                            currentClosePnL += active.lockedPnL;
                            active.minutePnLMap.set(t, active.lockedPnL);
                        }
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_RE_ASAP' && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                        const newTargetStrike = active.asapNextStrike || active.targetStrike;
                        
                        if (newTargetStrike !== active.targetStrike) {
                            const strikeStr = active.leg.strike || active.leg.strike_selection || "ATM";
                            const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
                            const type = match ? match[1] : "ATM";
                            
                            let fallbackDir = 'ALTERNATE';
                            if (type === 'OTM') fallbackDir = active.leg.option_type === 'CE' ? 'UP' : 'DOWN';
                            else if (type === 'ITM') fallbackDir = active.leg.option_type === 'CE' ? 'DOWN' : 'UP';

                            let { strike: finalTargetStrike, data: newOptionData } = await this.getValidOptionDataWithFallback(indexName, year, month, date, expiry, newTargetStrike, active.leg.option_type, step, t, 5, fallbackDir);
                            
                            if (finalTargetStrike !== newTargetStrike) {
                                console.log(`    -> RE-ASAP Fallback: Original new strike ${newTargetStrike} missing data, using ${finalTargetStrike}_${active.leg.option_type}`);
                                active.asapNextStrike = finalTargetStrike;
                            }
                            
                            if (newOptionData && newOptionData.length > 0) {
                                if (!active.historicalCharts) active.historicalCharts = [];
                                
                                const baselinePnL = active.strikeBaselinePnL || 0;
                                const slTime = active.trades[active.trades.length - 1]?.exitTime || t;
                                const oldChart = active.optionDayChart.map(node => {
                                    let pnl = 0;
                                    if (active.minutePnLMap && active.minutePnLMap.has(node.time)) pnl = active.minutePnLMap.get(node.time) - baselinePnL;
                                    return { ...node, pnl };
                                }).filter(node => node.time >= (active.strikeStartTime || entryTime) && node.time <= slTime);
                                
                                active.historicalCharts.push({
                                    key: `${active.targetStrike}_${active.leg.option_type}`,
                                    chart: oldChart,
                                    endTime: t
                                });
                                
                                active.strikeStartTime = t;
                                active.strikeBaselinePnL = active.lockedPnL;
                                
                                const newChartMap = new Map();
                                const newOptionDayChart = newOptionData.map(row => {
                                    const time = this.extractTimeOption(row);
                                    const mapped = { time, open: row[6], high: row[4], low: row[5], close: row[0], action: null };
                                    if (time) newChartMap.set(time, mapped);
                                    return mapped;
                                });
                                
                                active.targetStrike = newTargetStrike;
                                active.optionData = newOptionData;
                                active.chartMap = newChartMap;
                                active.optionDayChart = newOptionDayChart;
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    active.optionDayChart[idxLog].action = `[RE-ASAP] Loaded Strike for Re-entry`;
                                }
                            } else {
                                console.log(`    -> RE-ASAP Missing option data for new strike: ${newTargetStrike}_${active.leg.option_type}`);
                            }
                        }
                        
                        const newNode = active.chartMap.get(t);
                        if (newNode) {
                            if (active.leg.simple_mntm_enabled) {
                                active.state = 'WAITING_FOR_MNTM';
                                const basePrice = newNode.open;
                                let mtp = null;
                                let mMode = active.leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT';
                                let mVal = parseFloat(active.leg.simple_mntm_value || 0);
                                
                                if (mMode.includes("PLUS_PCT")) mtp = basePrice + (basePrice * mVal / 100);
                                else if (mMode.includes("PLUS_PTS")) mtp = basePrice + mVal;
                                else if (mMode.includes("MINUS_PCT")) mtp = basePrice - (basePrice * mVal / 100);
                                else if (mMode.includes("MINUS_PTS")) mtp = basePrice - mVal;
                                
                                active.mtp = roundToTick(mtp);
                                
                                const idxLogUpdate = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLogUpdate !== -1) {
                                    active.optionDayChart[idxLogUpdate].action = (active.optionDayChart[idxLogUpdate].action ? active.optionDayChart[idxLogUpdate].action + ' | ' : '') + `[RE-ASAP] Waiting MNTM: ₹${active.mtp.toFixed(2)}`;
                                }
                                
                                currentOpenPnL += active.lockedPnL;
                                currentClosePnL += active.lockedPnL;
                                active.minutePnLMap.set(t, active.lockedPnL);
                                continue;
                            } else {
                                active.state = 'ACTIVE';
                                active.reentryCount++;
                                active.entryTime = t;
                                active.entryPrice = newNode.open;
                                
                                active.slPrice = calculateSlPrice(active.leg, active.entryPrice, true);
                                active.tslReferencePrice = active.entryPrice;
                                
                                active.trades.push({
                                    entryTime: active.entryTime, entryPrice: active.entryPrice,
                                    exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                    tradeSlPrice: active.slPrice
                                });
                                dailyTradeValue += (active.entryPrice * active.qty);
                                
                                const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                if (idxLog !== -1) {
                                    const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                    const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                    const actionStrLog = `Re-Entry (${entrySideLog}) [RE-ASAP]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                    active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                }
                                
                                const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - newNode.open) : (newNode.open - active.entryPrice);
                                const newTradeOpenPnL = openPnlDiff * active.qty;
                                const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - newNode.close) : (newNode.close - active.entryPrice);
                                const newTradeClosePnL = closePnlDiff * active.qty;
                                
                                currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                                continue;
                            }
                        }
                        
                        currentOpenPnL += active.lockedPnL;
                        currentClosePnL += active.lockedPnL;
                        active.minutePnLMap.set(t, active.lockedPnL);
                        continue;
                    }

                    if (active.state === 'WAITING_FOR_LAZY' && !(active.leg.no_reentry_on_sl_candle && active.slHitMinute === t)) {
                        const newTargetStrike = active.lazyNextStrike || active.targetStrike;

                        const strikeStr = active.lazyLegConfig.strike || active.lazyLegConfig.strike_selection || "ATM";
                        const match = strikeStr.match(/^([A-Z]+)(\d*)$/);
                        const type = match ? match[1] : "ATM";
                        
                        let fallbackDir = 'ALTERNATE';
                        if (type === 'OTM') fallbackDir = active.lazyLegConfig.option_type === 'CE' ? 'UP' : 'DOWN';
                        else if (type === 'ITM') fallbackDir = active.lazyLegConfig.option_type === 'CE' ? 'DOWN' : 'UP';

                        let { strike: finalTargetStrike, data: newOptionData } = await this.getValidOptionDataWithFallback(indexName, year, month, date, expiry, newTargetStrike, active.lazyLegConfig.option_type, step, t, 5, fallbackDir);
                        
                        if (finalTargetStrike !== newTargetStrike) {
                            console.log(`    -> LAZY LEG Fallback: Original new strike ${newTargetStrike} missing data, using ${finalTargetStrike}_${active.lazyLegConfig.option_type}`);
                            active.lazyNextStrike = finalTargetStrike;
                        }

                        if (newOptionData && newOptionData.length > 0) {
                            if (!active.historicalCharts) active.historicalCharts = [];
                            
                            const baselinePnL = active.strikeBaselinePnL || 0;
                            const slTime = active.trades[active.trades.length - 1]?.exitTime || t;
                            const oldChart = active.optionDayChart.map(node => {
                                let pnl = 0;
                                if (active.minutePnLMap && active.minutePnLMap.has(node.time)) pnl = active.minutePnLMap.get(node.time) - baselinePnL;
                                return { ...node, pnl };
                            }).filter(node => node.time >= (active.strikeStartTime || entryTime) && node.time <= slTime);
                            
                            const phaseSuffix = active.historicalCharts.length > 0 ? ` (Leg ${active.historicalCharts.length + 1})` : ' (Leg 1)';
                            active.historicalCharts.push({
                                key: `${active.targetStrike}_${active.leg.option_type}${phaseSuffix}`,
                                chart: oldChart,
                                endTime: t
                            });
                            
                            active.strikeStartTime = t;
                            active.strikeBaselinePnL = active.lockedPnL;

                            active.leg = active.lazyLegConfig;
                            active.qty = active.leg.lots * lotsize * multiplier;
                            active.targetStrike = newTargetStrike;
                            active.optionData = newOptionData;
                            active.lazyLegConfig = null;
                            
                            const newChartMap = new Map();
                            const newOptionDayChart = newOptionData.map(row => {
                                const time = this.extractTimeOption(row);
                                const mapped = { time, open: row[6], high: row[4], low: row[5], close: row[0], action: null };
                                if (time) newChartMap.set(time, mapped);
                                return mapped;
                            });
                            active.chartMap = newChartMap;
                            active.optionDayChart = newOptionDayChart;
                            
                            const newNode = active.chartMap.get(t);
                            if (newNode) {
                                if (active.leg.simple_mntm_enabled) {
                                    active.state = 'WAITING_FOR_MNTM';
                                    const basePrice = newNode.open;
                                    let mtp = null;
                                    let mMode = active.leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT';
                                    let mVal = parseFloat(active.leg.simple_mntm_value || 0);
                                    
                                    if (mMode.includes("PLUS_PCT")) mtp = basePrice + (basePrice * mVal / 100);
                                    else if (mMode.includes("PLUS_PTS")) mtp = basePrice + mVal;
                                    else if (mMode.includes("MINUS_PCT")) mtp = basePrice - (basePrice * mVal / 100);
                                    else if (mMode.includes("MINUS_PTS")) mtp = basePrice - mVal;
                                    
                                    active.mtp = roundToTick(mtp);
                                    
                                    const idxLogUpdate = active.optionDayChart.findIndex(c => c.time === t);
                                    if (idxLogUpdate !== -1) {
                                        active.optionDayChart[idxLogUpdate].action = (active.optionDayChart[idxLogUpdate].action ? active.optionDayChart[idxLogUpdate].action + ' | ' : '') + `[LAZY LEG] Waiting MNTM: ₹${active.mtp.toFixed(2)}`;
                                    }
                                    
                                    currentOpenPnL += active.lockedPnL;
                                    currentClosePnL += active.lockedPnL;
                                    active.minutePnLMap.set(t, active.lockedPnL);
                                    continue;
                                } else {
                                    active.state = 'ACTIVE';
                                    active.reentryCount = 0; 
                                    active.entryTime = t;
                                    active.entryPrice = newNode.open;
                                    
                                    active.slPrice = calculateSlPrice(active.leg, active.entryPrice, false);
                                    active.tslReferencePrice = active.entryPrice;
                                    
                                    active.trades.push({
                                        entryTime: active.entryTime, entryPrice: active.entryPrice,
                                        exitTime: null, exitPrice: null, exitReason: null, tradePnL: 0, tradeValue: active.entryPrice * active.qty,
                                        tradeSlPrice: active.slPrice
                                    });
                                    dailyTradeValue += (active.entryPrice * active.qty);
                                    
                                    const idxLog = active.optionDayChart.findIndex(c => c.time === t);
                                    if (idxLog !== -1) {
                                        const slStrLog = active.slPrice !== null ? ` | Init SL: ₹${active.slPrice.toFixed(2)}` : '';
                                        const entrySideLog = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                                        const actionStrLog = `Initial Entry (${entrySideLog}) [LAZY LEG]: ${active.entryPrice.toFixed(2)}${slStrLog}`;
                                        active.optionDayChart[idxLog].action = active.optionDayChart[idxLog].action ? active.optionDayChart[idxLog].action + ' | ' + actionStrLog : actionStrLog;
                                    }
                                    
                                    const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - newNode.open) : (newNode.open - active.entryPrice);
                                    const newTradeOpenPnL = openPnlDiff * active.qty;
                                    const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - newNode.close) : (newNode.close - active.entryPrice);
                                    const newTradeClosePnL = closePnlDiff * active.qty;
                                    
                                    currentOpenPnL += active.lockedPnL + newTradeOpenPnL;
                                    currentClosePnL += active.lockedPnL + newTradeClosePnL;
                                    active.minutePnLMap.set(t, active.lockedPnL + newTradeClosePnL);
                                    continue;
                                }
                            } else {
                                console.log(`    -> LAZY LEG Missing new option data row at time ${t}`);
                            }
                        } else {
                            console.log(`    -> LAZY LEG Missing option data for new strike: ${newTargetStrike}_${active.lazyLegConfig.option_type}`);
                        }
                        
                        currentOpenPnL += active.lockedPnL;
                        currentClosePnL += active.lockedPnL;
                        active.minutePnLMap.set(t, active.lockedPnL);
                        continue;
                    }

                    if (active.state === 'ACTIVE') {
                        const openPrice = node.open;
                        const closePrice = node.close; 
                        
                        const openPnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - openPrice) : (openPrice - active.entryPrice);
                        const closePnlDiff = active.leg.side === 'SELL' ? (active.entryPrice - closePrice) : (closePrice - active.entryPrice);
                        
                        const legOpenPnL = active.lockedPnL + (openPnlDiff * active.qty);
                        const legClosePnL = active.lockedPnL + (closePnlDiff * active.qty);
                        
                        currentOpenPnL += legOpenPnL;
                        currentClosePnL += legClosePnL;
                        
                        if (!active.minutePnLMap) active.minutePnLMap = new Map();
                        active.minutePnLMap.set(t, active.lockedPnL + (closePnlDiff * active.qty));
                    } else if (active.state === 'WAITING_FOR_MNTM') {
                        if (!active.minutePnLMap) active.minutePnLMap = new Map();
                        active.minutePnLMap.set(t, active.lockedPnL);
                    }
                    
                    active.lastMinutePnL = active.minutePnLMap && active.minutePnLMap.has(t) ? active.minutePnLMap.get(t) : active.lockedPnL;
                }

                const slAmount = config.overall_sl_type === 'AMOUNT' ? slVal * multiplier : (dailyTradeValue * slVal / 100);
                if (slEnabled) {
                    if (currentOpenPnL <= -slAmount) {
                        console.log(`[DEBUG] OVER_SL triggered at ${t}. currentOpenPnL: ${currentOpenPnL}, slAmount: ${slAmount}, config type: ${config.overall_sl_type}, slVal: ${slVal}`);
                        actualExitTime = t;
                        exitReason = 'OVER_SL';
                        exitAtOpen = true;
                        break;
                    }
                    if (currentClosePnL <= -slAmount) {
                        console.log(`[DEBUG] OVER_SL triggered at ${t}. currentClosePnL: ${currentClosePnL}, slAmount: ${slAmount}, config type: ${config.overall_sl_type}, slVal: ${slVal}`);
                        actualExitTime = t;
                        exitReason = 'OVER_SL';
                        exitAtOpen = false;
                        break;
                    }
                }
                
                const targetAmount = config.overall_target_type === 'AMOUNT' ? targetVal * multiplier : (dailyTradeValue * targetVal / 100);
                if (targetEnabled) {
                    if (currentOpenPnL >= targetAmount) {
                        actualExitTime = t;
                        exitReason = 'OVER_TGT';
                        exitAtOpen = true;
                        break;
                    }
                    if (currentClosePnL >= targetAmount) {
                        actualExitTime = t;
                        exitReason = 'OVER_TGT';
                        exitAtOpen = false;
                        break;
                    }
                }
                
                dailyOverallPnLChart.push({ time: t, pnl: currentClosePnL });
            }

            // 6. Record Trades and Actions based on actualExitTime
            if (exitReason === 'EXIT_TIME') exitAtOpen = true;
            dailyPnL = 0;
            for (const active of activeLegs) {
                if (active.state === 'ACTIVE' && active.trades.length > 0) {
                    let exitTimeStr = actualExitTime;
                    let exitReasonStr = exitReason;

                    let exitNode = active.chartMap.get(exitTimeStr);
                    if (!exitNode) exitNode = active.optionDayChart.find(c => c.time >= exitTimeStr);
                    if (!exitNode) exitNode = active.optionDayChart[active.optionDayChart.length - 1]; // fallback

                    const exitPrice = exitAtOpen ? exitNode.open : exitNode.close;
                    const currentTrade = active.trades[active.trades.length - 1];
                    currentTrade.exitTime = exitNode.time;
                    currentTrade.exitPrice = exitPrice;
                    currentTrade.exitReason = exitReasonStr;
                    
                    const pnlDiff = active.leg.side === 'SELL' ? (currentTrade.entryPrice - exitPrice) : (exitPrice - currentTrade.entryPrice);
                    currentTrade.tradePnL = pnlDiff * active.qty;
                    active.lockedPnL += currentTrade.tradePnL;
                    if (active.minutePnLMap) {
                        active.minutePnLMap.set(currentTrade.exitTime, active.lockedPnL);
                    }
                }

                dailyPnL += active.lockedPnL;
            }
            
            console.log(`[DEBUG] Final dailyPnL after exit calculations: ${dailyPnL}`);

            const exitNodeOverall = dailyOverallPnLChart.find(x => x.time === actualExitTime);
            if (exitNodeOverall) {
                exitNodeOverall.pnl = dailyPnL;
            }

            for (const active of activeLegs) {
                const entrySide = active.leg.side === 'SELL' ? 'Sell' : 'Buy';
                const exitSide = active.leg.side === 'SELL' ? 'Buy' : 'Sell';

                // Process all trades for this leg
                for (let i = 0; i < active.trades.length; i++) {
                    const trade = active.trades[i];
                    
                    let tradeSymbol = `${active.targetStrike}_${active.leg.option_type}`;
                    let tradeChartRef = active.optionDayChart;
                    
                    if (active.historicalCharts) {
                        for (const hist of active.historicalCharts) {
                            if (trade.entryTime < hist.endTime) {
                                tradeSymbol = hist.key;
                                tradeChartRef = hist.chart;
                                break;
                            }
                        }
                    }

                    this.results.trades.push({
                        date: date,
                        leg_id: active.leg.id,
                        symbol: tradeSymbol,
                        side: active.leg.side,
                        entry_time: trade.entryTime,
                        entry_price: trade.entryPrice,
                        exit_time: trade.exitTime,
                        exit_price: trade.exitPrice,
                        exit_reason: trade.exitReason,
                        qty: active.qty,
                        pnl: trade.tradePnL,
                        trade_value: trade.tradeValue,
                        pnl_percent: trade.tradeValue > 0 ? (trade.tradePnL / trade.tradeValue) * 100 : 0
                    });

                    // Remove initial logging here because we now inject it dynamically on the exact minute
                    // Wait, if it wasn't MNTM, we still need to log the first entry at 09:16
                    if (i === 0 && !active.leg.simple_mntm_enabled) {
                        const cEntryIndex = tradeChartRef.findIndex(c => c.time === trade.entryTime);
                        if (cEntryIndex !== -1) {
                            const slStr = trade.tradeSlPrice !== null ? ` | Init SL: ₹${trade.tradeSlPrice.toFixed(2)}` : '';
                            const actionStr = `Entry (${entrySide}): ${trade.entryPrice.toFixed(2)}${slStr}`;
                            tradeChartRef[cEntryIndex].action = tradeChartRef[cEntryIndex].action ? tradeChartRef[cEntryIndex].action + ' | ' + actionStr : actionStr;
                        }
                    }
                    
                    const cExitIndex = tradeChartRef.findIndex(c => c.time === trade.exitTime);
                    if (cExitIndex !== -1) {
                        const reCalcStr = trade.reentryCalcStr ? ` | ${trade.reentryCalcStr}` : '';
                        const pnlColorStr = trade.tradePnL >= 0 ? '+' : '';
                        const pnlStr = ` | Locked PnL: ${pnlColorStr}₹${trade.tradePnL.toFixed(2)}`;
                        const actionStr = `Exit (${exitSide}) [${trade.exitReason}]: ${trade.exitPrice.toFixed(2)}${reCalcStr}${pnlStr}`;
                        tradeChartRef[cExitIndex].action = tradeChartRef[cExitIndex].action ? tradeChartRef[cExitIndex].action + ' | ' + actionStr : actionStr;
                    }
                }

                const startTime = active.strikeStartTime || entryTime;
                const baselinePnL = active.strikeBaselinePnL || 0;
                active.optionDayChart = active.optionDayChart.map(node => {
                    let pnl = 0;
                    if (active.minutePnLMap && active.minutePnLMap.has(node.time)) pnl = active.minutePnLMap.get(node.time) - baselinePnL;
                    else if (node.time > actualExitTime) pnl = 0;
                    return { ...node, pnl };
                }).filter(node => node.time >= startTime && node.time <= actualExitTime);

                if (active.historicalCharts) {
                    active.historicalCharts.forEach(hist => {
                        dayChart[hist.key] = hist.chart;
                    });
                }

                dayChart[`${active.targetStrike}_${active.leg.option_type}`] = active.optionDayChart;
                
                console.log(`    -> ${active.leg.side} ${active.qty}x ${active.targetStrike}_${active.leg.option_type} | Total PnL: ${active.lockedPnL.toFixed(2)} | Trades: ${active.trades.length}`);
            }
            
            const allDayTimes = Array.from(indexChartMap.keys()).sort();
            const fullDayOverallPnLChart = allDayTimes.map(t => {
                const matched = dailyOverallPnLChart.find(x => x.time === t);
                if (matched) return { time: t, pnl: matched.pnl };
                if (t < entryTime) return { time: t, pnl: 0 };
                return { time: t, pnl: dailyPnL };
            });
            dayChart['OVERALL_PNL'] = fullDayOverallPnLChart;
            
            // Calculate DTE by counting valid trading days (index files) between date (exclusive) and expiry (inclusive)
            let dte = 0;
            let currentTemp = new Date(date);
            currentTemp.setDate(currentTemp.getDate() + 1); // Start from the day after the current date
            const expiryObj = new Date(expiry);
            
            while (currentTemp <= expiryObj) {
                const tempDateStr = currentTemp.toISOString().split('T')[0];
                const [tempYear, tempMonth] = tempDateStr.split('-');
                const tempIndexFilePath = path.join(__dirname, `../../../../market-data/index/${indexName}/${tempYear}/${tempMonth}/${tempDateStr}.parquet`);
                
                if (fs.existsSync(tempIndexFilePath)) {
                    dte++;
                }
                currentTemp.setDate(currentTemp.getDate() + 1);
            }


            this.results.dailySummary[date] = {
                pnl: dailyPnL,
                trade_value: dailyTradeValue,
                pnl_percent: dailyTradeValue > 0 ? (dailyPnL / dailyTradeValue) * 100 : 0,
                dte: dte,
                expiry: expiry
            };
            this.results.totalPnL += dailyPnL;
            this.results.chartData = this.results.chartData || {};
            this.results.chartData[date] = dayChart;
            console.log(`  -> Day PnL: ${dailyPnL.toFixed(2)} | Trade Value: ${dailyTradeValue.toFixed(2)}`);
            
            // Yield to the event loop so BullMQ can renew the job lock
            await new Promise(resolve => setImmediate(resolve));
        }
        
        return this.results;
    }

    generateDateRange(start, end) {
        let current = new Date(start);
        const endData = new Date(end);
        const dates = [];
        while (current <= endData) {
            dates.push(current.toISOString().split('T')[0]);
            current.setDate(current.getDate() + 1);
        }
        return dates;
    }
}

module.exports = BacktestEngine;
