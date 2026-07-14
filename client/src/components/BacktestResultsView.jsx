import React, { useState } from'react';
import { X, TrendingUp, TrendingDown, Clock, Activity, CalendarDays, Settings2, ZoomIn, ZoomOut, RotateCcw } from'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from'@/components/ui/card';
import { Button } from'@/components/ui/button';
import { StrategyConfigModal } from'./StrategyConfigModal';
import { TradesSummaryTable } from'./TradesSummaryTable';

export const BacktestResultsView = ({ results, strategy }) => {
 const { totalPnL, dailySummary, chartData, trades } = results || {};

 // Sort dates
 const dates = Object.keys(chartData || {}).sort();
 const [activeTab, setActiveTab] = useState('OVERVIEW');
 const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
 const [zoomLevel, setZoomLevel] = useState(100);
 // Extract available strategies and DTEs
 const { availableStrategies, availableDTEsPerStrategy } = React.useMemo(() => {
 if (!dailySummary) return { availableStrategies: [], availableDTEsPerStrategy: {} };

 const strats = new Map();
 const dtes = {};

 Object.values(dailySummary).forEach(dayData => {
 if (typeof dayData ==='object') {
 if (dayData.strategies) {
 Object.entries(dayData.strategies).forEach(([sId, sData]) => {
 strats.set(sId, sId);
 if (!dtes[sId]) dtes[sId] = new Set();
 if (sData.dte !== undefined) dtes[sId].add(sData.dte);
 });
 } else {
 const sId = strategy?.id ||'single';
 strats.set(sId, strategy?.name ||'Strategy');
 if (!dtes[sId]) dtes[sId] = new Set();
 if (dayData.dte !== undefined) dtes[sId].add(dayData.dte);
 }
 }
 });

 const sortedDtes = {};
 Object.keys(dtes).forEach(k => {
 sortedDtes[k] = Array.from(dtes[k]).sort((a, b) => a - b);
 });

 let strategiesList = [];
 if (strategy?.isCombined && strategy?.strategies) {
 strategiesList = strategy.strategies.map(s => ({
 id: s.id,
 name: s.name || s.config?.name ||'Strategy'
 }));
 } else {
 strategiesList = Array.from(strats.keys()).map(id => ({
 id,
 name: strats.get(id) ||'Strategy'
 }));
 }

 return { availableStrategies: strategiesList, availableDTEsPerStrategy: sortedDtes };
 }, [dailySummary, strategy]);

 const allPossibleDTEs = React.useMemo(() => {
 const dtes = new Set();
 Object.values(availableDTEsPerStrategy).forEach(arr => arr.forEach(d => dtes.add(d)));
 return Array.from(dtes).sort((a, b) => parseInt(a) - parseInt(b));
 }, [availableDTEsPerStrategy]);

 const [selectedStrategies, setSelectedStrategies] = useState(() => {
 const sel = new Set();
 if (strategy?.isCombined && strategy?.strategies) {
 strategy.strategies.forEach(s => sel.add(s.id));
 } else if (strategy?.id) {
 sel.add(strategy.id);
 } else {
 sel.add('single');
 }
 return sel;
 });

 const [selectedDTEs, setSelectedDTEs] = useState({});
 const [strategyMultipliers, setStrategyMultipliers] = useState({});
 const [dteQuantities, setDteQuantities] = useState({}); // { strategyId: { dte: qty } }

 // Helper: get effective multiplier for a strategy+DTE combo
 const getEffectiveMultiplier = React.useCallback((sId, dte) => {
 const dteQty = dteQuantities[sId]?.[dte];
 if (dteQty !== undefined && dteQty !=='') return dteQty;
 return strategyMultipliers[sId] !== undefined && strategyMultipliers[sId] !=='' ? strategyMultipliers[sId] : 1;
 }, [dteQuantities, strategyMultipliers]);

 // Portfolio Risk Config
 const [portfolioMaxLoss, setPortfolioMaxLoss] = useState('');
 const [portfolioTarget, setPortfolioTarget] = useState('');
 const [portfolioRiskType, setPortfolioRiskType] = useState('AMOUNT'); //'AMOUNT' or'PERCENT'
 const [earlyProfitValue, setEarlyProfitValue] = useState('');
 const [earlyProfitTime, setEarlyProfitTime] = useState('');

 // UI states for dropdowns
 const [openStrategyDropdown, setOpenStrategyDropdown] = useState(false);
 const [openCommonDTEDropdown, setOpenCommonDTEDropdown] = useState(false);
 const [commonDTEs, setCommonDTEs] = useState([]);
 const [openDTEDropdownFor, setOpenDTEDropdownFor] = useState(null);

 // Initialize selectedDTEs and commonDTEs with all available DTEs so"All Days" starts checked
 const [dteInitialized, setDteInitialized] = React.useState(false);
 React.useEffect(() => {
 if (!dteInitialized && Object.keys(availableDTEsPerStrategy).length > 0) {
 const initial = {};
 Object.entries(availableDTEsPerStrategy).forEach(([sId, dtes]) => {
 initial[sId] = [...dtes];
 });
 setSelectedDTEs(initial);
 setCommonDTEs([...allPossibleDTEs]);
 setDteInitialized(true);
 }
 }, [availableDTEsPerStrategy, allPossibleDTEs, dteInitialized]);

 const handleResetConfig = React.useCallback(() => {
 // Reset Portfolio Risk
 setPortfolioMaxLoss('');
 setPortfolioTarget('');
 setPortfolioRiskType('AMOUNT');
 setEarlyProfitValue('');
 setEarlyProfitTime('');

 // Reset strategy selection
 const sel = new Set();
 if (strategy?.isCombined && strategy?.strategies) {
 strategy.strategies.forEach(s => sel.add(s.id));
 } else if (strategy?.id) {
 sel.add(strategy.id);
 } else {
 sel.add('single');
 }
 setSelectedStrategies(sel);

 // Reset DTEs
 const initialDtes = {};
 Object.entries(availableDTEsPerStrategy).forEach(([sId, dtes]) => {
 initialDtes[sId] = [...dtes];
 });
 setSelectedDTEs(initialDtes);
 setCommonDTEs([...allPossibleDTEs]);

 // Reset multipliers
 setStrategyMultipliers({});
 setDteQuantities({});

 // Close dropdowns
 setOpenStrategyDropdown(false);
 setOpenCommonDTEDropdown(false);
 setOpenDTEDropdownFor(null);
 }, [strategy, availableDTEsPerStrategy, allPossibleDTEs]);

 const filteredDailySummary = React.useMemo(() => {
 if (!dailySummary) return {};

 const filtered = {};
 Object.entries(dailySummary).forEach(([date, dayData]) => {
 if (typeof dayData ==='object') {
 let dayPnL = 0;
 let dayTradeValue = 0;
 let isTraded = false;
 const activeStrategyKeys = new Set();

 if (dayData.strategies) {
 Object.entries(dayData.strategies).forEach(([sId, sData]) => {
 if (selectedStrategies.has(sId)) {
 const dteFilters = selectedDTEs[sId] || [];
 if (dteFilters.length === 0 || dteFilters.includes(sData.dte)) {
 const multi = getEffectiveMultiplier(sId, sData.dte);
 dayPnL += ((sData.pnl || 0) * multi);
 dayTradeValue += ((sData.trade_value || 0) * multi);
 isTraded = true;
 activeStrategyKeys.add(sId);
 }
 }
 });
 } else {
 const sId = strategy?.id ||'single';
 if (selectedStrategies.has(sId)) {
 const dteFilters = selectedDTEs[sId] || [];
 if (dteFilters.length === 0 || dteFilters.includes(dayData.dte)) {
 const multi = getEffectiveMultiplier(sId, dayData.dte);
 dayPnL += ((dayData.pnl || 0) * multi);
 dayTradeValue += ((dayData.trade_value || 0) * multi);
 isTraded = true;
 activeStrategyKeys.add(sId);
 }
 }
 }

 if (isTraded && chartData && chartData[date] && (portfolioMaxLoss !=='' || portfolioTarget !=='' || earlyProfitValue !=='')) {
 const timeMap = {};
 let hasData = false;

 // Build a map of strategyId -> dte for this day
 const stratDteMap = {};
 if (dayData.strategies) {
 Object.entries(dayData.strategies).forEach(([sId, sData]) => {
 stratDteMap[sId] = sData.dte;
 });
 } else {
 const sId = strategy?.id ||'single';
 stratDteMap[sId] = dayData.dte;
 }

 const allTimes = new Set();
 const legTimeMap = {};
 for (const [key, tickArray] of Object.entries(chartData[date])) {
 const sIdForMap = strategy?.isCombined ? key.split('_')[0] : (strategy?.id ||'single');
 if (key !=='OVERALL_PNL' && activeStrategyKeys.has(sIdForMap) && Array.isArray(tickArray)) {
 legTimeMap[key] = {};
 tickArray.forEach(t => {
 if (t && t.time) {
 allTimes.add(t.time);
 legTimeMap[key][t.time] = t.pnl;
 }
 });
 hasData = true;
 }
 }

 if (hasData) {
 const times = Array.from(allTimes).sort();
 const legLastPnL = {};
 times.forEach(t => {
 let totalAtTime = 0;
 for (const key of Object.keys(legTimeMap)) {
 const sId = strategy?.isCombined ? key.split('_')[0] : (strategy?.id ||'single');
 const multi = getEffectiveMultiplier(sId, stratDteMap[sId]);
 if (legTimeMap[key][t] !== undefined) legLastPnL[key] = legTimeMap[key][t];
 totalAtTime += ((legLastPnL[key] || 0) * multi);
 }
 timeMap[t] = totalAtTime;
 });

 let clippedPnL = null;
 const maxL = parseFloat(portfolioMaxLoss);
 const maxT = parseFloat(portfolioTarget);
 const limitSL = portfolioRiskType ==='PERCENT' && !isNaN(maxL) ? (dayTradeValue * maxL / 100) : maxL;
 const limitTarget = portfolioRiskType ==='PERCENT' && !isNaN(maxT) ? (dayTradeValue * maxT / 100) : maxT;

 for (const t of times) {
 const pnlAtTime = timeMap[t];
 if (!isNaN(limitSL) && limitSL > 0 && pnlAtTime <= -limitSL) {
 clippedPnL = pnlAtTime;
 break;
 }
 if (!isNaN(limitTarget) && limitTarget > 0 && pnlAtTime >= limitTarget) {
 clippedPnL = pnlAtTime;
 break;
 }
 // Early Profit Exit: if PnL reaches target before the configured time
 const earlyVal = parseFloat(earlyProfitValue);
 const earlyTime = earlyProfitTime ? earlyProfitTime.substring(0, 5) :'';
 if (!isNaN(earlyVal) && earlyVal > 0 && earlyTime && t < earlyTime && pnlAtTime >= earlyVal) {
 clippedPnL = pnlAtTime;
 break;
 }
 }
 if (clippedPnL !== null) {
 dayPnL = clippedPnL;
 }
 }
 }

 if (isTraded) {
 filtered[date] = {
 pnl: dayPnL,
 trade_value: dayTradeValue,
 pnl_percent: dayTradeValue > 0 ? (dayPnL / dayTradeValue) * 100 : 0
 };
 }
 }
 });
 return filtered;
 }, [dailySummary, chartData, selectedStrategies, selectedDTEs, strategyMultipliers, dteQuantities, getEffectiveMultiplier, strategy, portfolioMaxLoss, portfolioTarget, portfolioRiskType, earlyProfitValue, earlyProfitTime]);

 const isProfitable = totalPnL >= 0;

 const analytics = React.useMemo(() => {
 if (!filteredDailySummary) return [];

 const yearly = {};

 Object.entries(filteredDailySummary).forEach(([date, dayData]) => {
 const [yyyy, mm] = date.split('-');
 const dayPnL = typeof dayData ==='object' ? (dayData.pnl || 0) : (dayData || 0);

 if (!yearly[yyyy]) {
 yearly[yyyy] = {
 year: yyyy,
 months: {'01': 0,'02': 0,'03': 0,'04': 0,'05': 0,'06': 0,'07': 0,'08': 0,'09': 0,'10': 0,'11': 0,'12': 0 },
 total: 0,
 cumulativeBalance: 0,
 maxBalance: 0,
 mdd: 0,
 mddDays: 0,
 currentDrawdownDays: 0
 };
 }

 yearly[yyyy].months[mm] += dayPnL;
 yearly[yyyy].total += dayPnL;

 // Drawdown calculation
 yearly[yyyy].cumulativeBalance += dayPnL;
 if (yearly[yyyy].cumulativeBalance > yearly[yyyy].maxBalance) {
 yearly[yyyy].maxBalance = yearly[yyyy].cumulativeBalance;
 yearly[yyyy].currentDrawdownDays = 0;
 } else {
 yearly[yyyy].currentDrawdownDays += 1;
 const currentDrawdown = yearly[yyyy].cumulativeBalance - yearly[yyyy].maxBalance;
 if (currentDrawdown < yearly[yyyy].mdd) {
 yearly[yyyy].mdd = currentDrawdown;
 }
 if (yearly[yyyy].currentDrawdownDays > yearly[yyyy].mddDays) {
 yearly[yyyy].mddDays = yearly[yyyy].currentDrawdownDays;
 }
 }
 });

 return Object.values(yearly).sort((a, b) => a.year.localeCompare(b.year));
 }, [filteredDailySummary]);

 const overallStats = React.useMemo(() => {
 if (!filteredDailySummary) return null;

 const entries = Object.entries(filteredDailySummary).map(([date, d]) => ({ date, pnl: typeof d ==='object' ? (d.pnl || 0) : (d || 0) }));
 if (entries.length === 0) return null;

 let winningDays = [];
 let losingDays = [];
 let maxProfit = 0;
 let maxProfitDate = null;
 let maxLoss = 0;
 let maxLossDate = null;

 let cumulativeBalance = 0;
 let maxBalance = 0;
 let maxDrawdown = 0;
 let currentDrawdownDays = 0;
 let maxDrawdownDays = 0;

 let currentDrawdownTrades = 0;
 let maxDrawdownTrades = 0;

 let currentDrawdownStartDate = null;
 let maxDrawdownStartDate = null;
 let maxDrawdownEndDate = null;

 const tradesCountByDate = {};
 if (trades) {
 trades.forEach(t => {
 if (!tradesCountByDate[t.date]) tradesCountByDate[t.date] = 0;
 tradesCountByDate[t.date]++;
 });
 }

 let currentWinStreak = 0;
 let maxWinStreak = 0;
 let currentLoseStreak = 0;
 let maxLoseStreak = 0;

 entries.forEach(({ date, pnl }) => {
 if (pnl > 0) {
 winningDays.push(pnl);
 currentWinStreak++;
 currentLoseStreak = 0;
 if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
 } else if (pnl < 0) {
 losingDays.push(pnl);
 currentLoseStreak++;
 currentWinStreak = 0;
 if (currentLoseStreak > maxLoseStreak) maxLoseStreak = currentLoseStreak;
 } else {
 currentWinStreak = 0;
 currentLoseStreak = 0;
 }

 if (pnl > maxProfit) {
 maxProfit = pnl;
 maxProfitDate = date;
 }
 if (pnl < maxLoss) {
 maxLoss = pnl;
 maxLossDate = date;
 }

 // DD Calc
 cumulativeBalance += pnl;
 const dayTradesCount = tradesCountByDate[date] || 0;
 if (cumulativeBalance > maxBalance) {
 maxBalance = cumulativeBalance;
 currentDrawdownDays = 0;
 currentDrawdownTrades = 0;
 currentDrawdownStartDate = null;
 } else {
 if (currentDrawdownDays === 0) currentDrawdownStartDate = date;
 currentDrawdownDays++;
 currentDrawdownTrades += dayTradesCount;

 const dd = cumulativeBalance - maxBalance;
 if (dd < maxDrawdown) maxDrawdown = dd;
 if (currentDrawdownDays > maxDrawdownDays) {
 maxDrawdownDays = currentDrawdownDays;
 maxDrawdownStartDate = currentDrawdownStartDate;
 maxDrawdownEndDate = date;
 }
 if (currentDrawdownTrades > maxDrawdownTrades) {
 maxDrawdownTrades = currentDrawdownTrades;
 }
 }
 });

 const totalTrades = entries.length;
 const totalWin = winningDays.reduce((a, b) => a + b, 0);
 const totalLoss = losingDays.reduce((a, b) => a + b, 0);
 const dynamicTotalPnL = totalWin + totalLoss;

 const avgProfit = winningDays.length > 0 ? totalWin / winningDays.length : 0;
 const avgLoss = losingDays.length > 0 ? totalLoss / losingDays.length : 0;
 const avgTrade = dynamicTotalPnL / (totalTrades || 1);

 const winRate = (winningDays.length / totalTrades) * 100;
 const lossRate = (losingDays.length / totalTrades) * 100;

 const uniqueMonths = new Set(entries.map(e => e.date.substring(0, 7)));
 const totalMonths = uniqueMonths.size || 1;
 const annualizedReturn = (dynamicTotalPnL / totalMonths) * 12;
 const returnOnMDD = maxDrawdown !== 0 ? Math.abs(annualizedReturn / maxDrawdown) : 0;
 const riskReward = avgLoss !== 0 ? Math.abs(avgProfit / avgLoss) : 0;

 const expectancy = ((winRate / 100) * avgProfit) + ((lossRate / 100) * avgLoss);
 const expectancyRatio = avgLoss !== 0 ? (expectancy / Math.abs(avgLoss)) : 0;

 return {
 totalPnL: dynamicTotalPnL,
 totalTrades,
 avgTrade,
 winRate,
 lossRate,
 avgProfit,
 avgLoss,
 maxProfit,
 maxProfitDate,
 maxLoss,
 maxLossDate,
 maxDrawdown,
 maxDrawdownDays,
 maxDrawdownTrades,
 maxDrawdownStartDate,
 maxDrawdownEndDate,
 returnOnMDD,
 riskReward,
 expectancyRatio,
 maxWinStreak,
 maxLoseStreak
 };
 }, [filteredDailySummary, trades]);

 const groupedDates = React.useMemo(() => {
 if (!filteredDailySummary) return {};
 const dates = Object.keys(filteredDailySummary).sort();
 const grouped = {};
 dates.forEach(date => {
 const [year, month] = date.split('-');
 if (!grouped[year]) grouped[year] = {};
 if (!grouped[year][month]) {
 const monthName = new Date(parseInt(year), parseInt(month) - 1).toLocaleString('default', { month:'long' });
 grouped[year][month] = { name: monthName, dates: [] };
 }
 grouped[year][month].dates.push(date);
 });
 return grouped;
 }, [filteredDailySummary]);

 if (!results) {
 return (
 <div className="h-full flex items-center justify-center">
 <div className="text-center space-y-3">
 <Activity className="h-10 w-10 text-slate-300 mx-auto" />
 <h3 className="text-sm font-semibold text-slate-600">No Backtest Results</h3>
 <p className="text-xs text-slate-400">Run a backtest from the Strategies tab to see results here.</p>
 </div>
 </div>
 );
 }

 return (
 <div className="w-full h-[calc(100vh-76px)] flex flex-col bg-white overflow-hidden animate-in fade-in duration-200">
 {/* Header */}
 <div className="bg-slate-900 px-4 py-2 flex items-center justify-between shrink-0 border-b border-slate-800">
 <div className="flex items-center gap-3">
 <div className="h-8 w-8 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
 <Activity className="h-4 w-4" />
 </div>
 <div>
 <h3 className="text-[12px] font-bold text-white uppercase tracking-wider">{strategy?.name ||'Backtest Results'}</h3>
 <p className="text-[9px] text-slate-400 font-medium">Historical Simulation Report</p>
 </div>
 </div>

 <div className="flex items-center gap-4">
 <Button
 variant="outline"
 size="sm"
 className="bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white h-7 text-xs px-2"
 onClick={() => setIsConfigModalOpen(true)}
 >
 <Settings2 className="h-3 w-3 mr-1.5" />
 View Config
 </Button>
 </div>
 </div>

 <div className="flex flex-1 overflow-hidden">
 {/* Sidebar Tabs */}
 <div className="w-40 bg-slate-50 border-r border-slate-100 flex flex-col overflow-y-auto shrink-0 custom-scrollbar">
 <div className="p-2 border-b border-slate-100">
 <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5 ml-1">
 <CalendarDays className="h-3 w-3" /> Trading Days
 </div>
 </div>
 <div className="p-1.5 space-y-0.5">
 <button
 onClick={() => setActiveTab('OVERVIEW')}
 className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center justify-between transition-all ${activeTab ==='OVERVIEW'
 ?'bg-white border border-slate-200 ring-1 ring-slate-200/50'
 :'hover:bg-slate-100 border border-transparent'
 }`}
 >
 <span className={`text-[11px] font-bold ${activeTab ==='OVERVIEW' ?'text-indigo-600' :'text-slate-600'}`}>
 Analytics Overview
 </span>
 </button>

 <div className="my-1 border-t border-slate-100" />

 <div className="space-y-3 pt-1">
 {Object.keys(groupedDates).sort((a, b) => b.localeCompare(a)).map(year => (
 <div key={year} className="space-y-1">
 <div className="px-2 py-0.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest sticky top-0 bg-slate-50 z-10 border-b border-slate-100/50">{year}</div>
 {Object.keys(groupedDates[year]).sort((a, b) => b.localeCompare(a)).map(month => (
 <div key={`${year}-${month}`} className="space-y-0.5 pl-1.5">
 <div className="px-1 py-0.5 text-[9px] font-bold text-indigo-400/80 uppercase tracking-widest">{groupedDates[year][month].name}</div>
 <div className="space-y-0.5 border-l-2 border-slate-100/60 ml-2 pl-2">
 {groupedDates[year][month].dates.sort((a, b) => b.localeCompare(a)).map(date => {
 const daySummary = typeof filteredDailySummary[date] ==='object' ? filteredDailySummary[date] : { pnl: filteredDailySummary[date] || 0 };
 const dayPnL = daySummary.pnl || 0;
 const isDayProfitable = dayPnL >= 0;

 // Format date as just DD to save space since month/year are grouped
 const dayStr = date.split('-')[2];

 return (
 <button
 key={date}
 onClick={() => setActiveTab(date)}
 className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center justify-between transition-all ${activeTab === date
 ?'bg-white border border-slate-200 ring-1 ring-slate-200/50'
 :'hover:bg-slate-100 border border-transparent'
 }`}
 >
 <span className={`text-[11px] font-bold ${activeTab === date ?'text-slate-800' :'text-slate-600'}`}>
 {dayStr} {groupedDates[year][month].name.substring(0, 3)}
 </span>
 <span className={`text-[9px] font-bold ${isDayProfitable ?'text-emerald-600' :'text-rose-600'}`}>
 {isDayProfitable ?'+' :''}{dayPnL.toFixed(0)}
 </span>
 </button>
 );
 })}
 </div>
 </div>
 ))}
 </div>
 ))}
 </div>

 {Object.keys(filteredDailySummary).length === 0 && (
 <div className="p-2 text-center text-[10px] text-slate-500 font-medium">No dates traded</div>
 )}
 </div>
 </div>

 {/* Main Content Area */}
 <div className="flex-1 flex flex-col bg-white overflow-hidden">
 {activeTab ==='OVERVIEW' ? (
 <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-slate-50 custom-scrollbar">
 {/* Backtest Configuration Section */}
 <div className="bg-white border border-slate-200 rounded-lg p-3.5 mb-6">
 <div className="flex justify-between items-center mb-3">
 <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
 <Settings2 className="h-3.5 w-3.5" /> Backtest Configuration
 </h3>
 <button
 onClick={handleResetConfig}
 className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-slate-100 text-slate-600 rounded border border-slate-200 text-[10px] font-bold transition-colors"
 >
 <RotateCcw className="w-3 h-3" /> Reset
 </button>
 </div>
 <div className="flex flex-wrap items-center gap-3">
 {/* Portfolio Risk Limits */}
 <div className="flex items-center gap-1.5 p-1 bg-white border border-slate-200 rounded-lg">
 <div className="flex items-center bg-slate-50 border border-slate-200 rounded text-[10px] font-bold overflow-hidden h-7">
 <button
 onClick={() => setPortfolioRiskType('AMOUNT')}
 className={`px-2 h-full transition-colors ${portfolioRiskType ==='AMOUNT' ?'bg-indigo-600 text-white' :'text-slate-500 hover:bg-slate-100'}`}
 >₹</button>
 <button
 onClick={() => setPortfolioRiskType('PERCENT')}
 className={`px-2 h-full border-l border-slate-200 transition-colors ${portfolioRiskType ==='PERCENT' ?'bg-indigo-600 text-white' :'text-slate-500 hover:bg-slate-100'}`}
 >%</button>
 </div>
 <div className="flex items-center px-2 h-7 bg-slate-50 border border-slate-200 rounded">
 <span className="text-[10px] text-slate-400 font-bold mr-1">SL:</span>
 <input
 type="number"
 value={portfolioMaxLoss}
 onChange={e => setPortfolioMaxLoss(e.target.value)}
 placeholder={portfolioRiskType ==='AMOUNT' ?"Amt" :"Pct"}
 className="w-12 bg-transparent border-none focus:ring-0 text-[10px] font-bold text-rose-600 p-0 text-right"
 />
 </div>
 <div className="flex items-center px-2 h-7 bg-slate-50 border border-slate-200 rounded">
 <span className="text-[10px] text-slate-400 font-bold mr-1">TG:</span>
 <input
 type="number"
 value={portfolioTarget}
 onChange={e => setPortfolioTarget(e.target.value)}
 placeholder={portfolioRiskType ==='AMOUNT' ?"Amt" :"Pct"}
 className="w-12 bg-transparent border-none focus:ring-0 text-[10px] font-bold text-emerald-600 p-0 text-right"
 />
 </div>
 </div>

 {/* Early Profit Exit */}
 <div className="flex items-center gap-1.5 p-1 bg-white border border-blue-200 rounded-lg">
 <div className="flex items-center px-2 h-7 bg-blue-50 border border-blue-200 rounded">
 <span className="text-[10px] text-blue-400 font-bold mr-1 whitespace-nowrap">EP ₹:</span>
 <input
 type="number"
 value={earlyProfitValue}
 onChange={e => setEarlyProfitValue(e.target.value)}
 placeholder="Amt"
 className="w-12 bg-transparent border-none focus:ring-0 text-[10px] font-bold text-blue-600 p-0 text-right"
 />
 </div>
 <div className="flex items-center px-2 h-7 bg-blue-50 border border-blue-200 rounded">
 <span className="text-[10px] text-blue-400 font-bold mr-1">By:</span>
 <input
 type="time"
 value={earlyProfitTime}
 onChange={e => setEarlyProfitTime(e.target.value)}
 className="w-16 bg-transparent border-none focus:ring-0 text-[10px] font-bold text-blue-600 p-0"
 />
 </div>
 </div>

 {/* Common Portfolio Qty Multiplier */}
 <div className="flex items-center bg-white rounded border border-slate-200 h-7 text-[11px]">
 <span className="text-[9px] text-slate-400 font-bold px-2 uppercase tracking-wide whitespace-nowrap">All Qty</span>
 <div className="w-[1px] h-4 bg-slate-200 shrink-0"></div>
 <div className="flex items-center h-full px-1.5 bg-slate-50 rounded-r">
 <button
 type="button"
 onClick={() => {
 const currentAll = Object.values(strategyMultipliers);
 const base = currentAll.length > 0 ? Math.min(...currentAll.map(v => typeof v ==='number' ? v : 1)) : 1;
 const newVal = Math.max(0, base - 1);
 const updated = {};
 Array.from(selectedStrategies).forEach(sId => { updated[sId] = newVal; });
 setStrategyMultipliers(prev => ({ ...prev, ...updated }));
 setDteQuantities({});
 }}
 className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 text-[11px] font-bold transition-colors leading-none"
 >−</button>
 <input
 type="number"
 min="0"
 step="0.5"
 value={(() => {
 const vals = Array.from(selectedStrategies).map(sId => strategyMultipliers[sId] !== undefined ? strategyMultipliers[sId] : 1);
 const allSame = vals.length > 0 && vals.every(v => v === vals[0]);
 return allSame ? vals[0] :'';
 })()}
 placeholder="—"
 onChange={(e) => {
 const val = e.target.value ==='' ?'' : parseFloat(e.target.value);
 const updated = {};
 Array.from(selectedStrategies).forEach(sId => { updated[sId] = val; });
 setStrategyMultipliers(prev => ({ ...prev, ...updated }));
 setDteQuantities({});
 }}
 onBlur={(e) => {
 if (e.target.value ==='') {
 const updated = {};
 Array.from(selectedStrategies).forEach(sId => { updated[sId] = 1; });
 setStrategyMultipliers(prev => ({ ...prev, ...updated }));
 }
 }}
 className="w-8 font-bold text-center outline-none bg-transparent text-indigo-600 focus:bg-white focus:ring-1 focus:ring-indigo-500 rounded py-0.5 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
 />
 <button
 type="button"
 onClick={() => {
 const currentAll = Object.values(strategyMultipliers);
 const base = currentAll.length > 0 ? Math.max(...currentAll.map(v => typeof v ==='number' ? v : 1)) : 1;
 const newVal = base + 1;
 const updated = {};
 Array.from(selectedStrategies).forEach(sId => { updated[sId] = newVal; });
 setStrategyMultipliers(prev => ({ ...prev, ...updated }));
 setDteQuantities({});
 }}
 className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 text-[11px] font-bold transition-colors leading-none"
 >+</button>
 <span className="text-[10px] text-slate-400 font-bold ml-0.5">x</span>
 </div>
 </div>
 {/* Strategy Selection Dropdown */}
 {availableStrategies.length > 0 && (
 <div className="relative">
 <button
 onClick={() => setOpenStrategyDropdown(!openStrategyDropdown)}
 className={`px-2.5 py-1.5 rounded text-[11px] font-bold border transition-all flex items-center gap-1.5 ${openStrategyDropdown ?'bg-indigo-50 border-indigo-200 text-indigo-700' :'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
 >
 Strategies
 <span className="bg-indigo-100 text-indigo-700 px-1.5 rounded-full text-[9px]">{selectedStrategies.size}</span>
 </button>
 {openStrategyDropdown && (
 <>
 <div className="fixed inset-0 z-10" onClick={() => setOpenStrategyDropdown(false)} />
 <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-lg z-20 py-1 max-h-60 overflow-y-auto">
 <label className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={selectedStrategies.size === availableStrategies.length}
 onChange={() => {
 if (selectedStrategies.size === availableStrategies.length) {
 setSelectedStrategies(new Set());
 } else {
 setSelectedStrategies(new Set(availableStrategies.map(s => s.id)));
 }
 }}
 />
 <span className="text-[11px] font-bold text-slate-700">Select All</span>
 </label>
 {availableStrategies.map(strat => (
 <label key={strat.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={selectedStrategies.has(strat.id)}
 onChange={(e) => {
 const newSet = new Set(selectedStrategies);
 if (e.target.checked) newSet.add(strat.id);
 else newSet.delete(strat.id);
 setSelectedStrategies(newSet);
 }}
 />
 <span className="text-[11px] font-medium text-slate-700 truncate" title={strat.name}>{strat.name}</span>
 </label>
 ))}
 </div>
 </>
 )}
 </div>
 )}

 {/* Common DTE Dropdown */}
 {allPossibleDTEs.length > 0 && (
 <div className="relative">
 <button
 onClick={() => setOpenCommonDTEDropdown(!openCommonDTEDropdown)}
 className={`px-2.5 py-1.5 rounded text-[11px] font-bold border transition-all flex items-center gap-1.5 ${openCommonDTEDropdown ?'bg-indigo-50 border-indigo-200 text-indigo-700' :'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
 >
 Common DTE
 {commonDTEs.length > 0 && <span className="bg-indigo-100 text-indigo-700 px-1.5 rounded-full text-[9px]">{commonDTEs.length}</span>}
 </button>
 {openCommonDTEDropdown && (
 <>
 <div className="fixed inset-0 z-10" onClick={() => setOpenCommonDTEDropdown(false)} />
 <div className="absolute left-0 top-full mt-1 w-48 bg-white border border-slate-200 rounded-lg z-20 py-1 max-h-60 overflow-y-auto flex flex-col">
 <div className="p-2 border-b border-slate-100 bg-slate-50/50 sticky top-0 z-10">
 <button
 onClick={() => {
 const newDtes = {};
 Array.from(selectedStrategies).forEach(sId => {
 newDtes[sId] = [...commonDTEs];
 });
 setSelectedDTEs(newDtes);
 setOpenCommonDTEDropdown(false);
 }}
 className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold rounded transition-colors"
 >
 Apply to Selected Strategies
 </button>
 </div>
 <label className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={commonDTEs.length === allPossibleDTEs.length}
 onChange={() => {
 if (commonDTEs.length === allPossibleDTEs.length) {
 setCommonDTEs([]);
 } else {
 setCommonDTEs([...allPossibleDTEs]);
 }
 }}
 />
 <span className="text-[11px] font-bold text-slate-700">All Days</span>
 </label>
 {allPossibleDTEs.map(dte => {
 const isSelected = commonDTEs.includes(dte);
 return (
 <label key={dte} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={isSelected}
 onChange={(e) => {
 if (e.target.checked) setCommonDTEs([...commonDTEs, dte]);
 else setCommonDTEs(commonDTEs.filter(d => d !== dte));
 }}
 />
 <span className="text-[11px] font-medium text-slate-700">DTE {dte}</span>
 </label>
 );
 })}
 </div>
 </>
 )}
 </div>
 )}

 {/* Per-Strategy DTE Dropdowns */}
 {Array.from(selectedStrategies).map(sId => {
 const dtes = availableDTEsPerStrategy[sId] || [];
 const sName = availableStrategies.find(s => s.id === sId)?.name ||'Strategy';
 const selDtes = selectedDTEs[sId] || [];
 const isOpen = openDTEDropdownFor === sId;
 const defaultQty = strategyMultipliers[sId] !== undefined && strategyMultipliers[sId] !=='' ? strategyMultipliers[sId] : 1;

 return (
 <div key={sId} className="flex items-center bg-white rounded border border-slate-200 h-7 text-[11px] group/widget">
 {/* DTE Dropdown */}
 {dtes.length > 0 ? (
 <div className="relative h-full">
 <button
 onClick={() => setOpenDTEDropdownFor(isOpen ? null : sId)}
 className={`h-full px-2.5 font-bold rounded-l transition-all flex items-center gap-1.5 ${isOpen ?'bg-indigo-50 text-indigo-700' :'text-slate-700 hover:bg-slate-50'}`}
 >
 <span className="max-w-[80px] truncate" title={sName}>{sName}</span> DTE
 {selDtes.length > 0 && <span className="bg-indigo-100 text-indigo-700 px-1.5 py-[2px] rounded-full text-[9px] font-bold leading-none">{selDtes.length}</span>}
 </button>
 {isOpen && (
 <>
 <div className="fixed inset-0 z-10" onClick={() => setOpenDTEDropdownFor(null)} />
 <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-lg z-20 py-1 max-h-60 overflow-y-auto">
 <label className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={selDtes.length === dtes.length}
 onChange={() => {
 if (selDtes.length === dtes.length) {
 setSelectedDTEs({ ...selectedDTEs, [sId]: [] });
 } else {
 setSelectedDTEs({ ...selectedDTEs, [sId]: [...dtes] });
 }
 }}
 />
 <span className="text-[11px] font-bold text-slate-700">All Days</span>
 </label>
 {dtes.map(dte => {
 const isSelected = selDtes.includes(dte);
 const dteQtyVal = dteQuantities[sId]?.[dte];
 const displayQty = dteQtyVal !== undefined && dteQtyVal !=='' ? dteQtyVal : defaultQty;
 return (
 <div key={dte} className="flex items-center justify-between px-3 py-2 hover:bg-slate-50 group/dte">
 <label className="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0">
 <input
 type="checkbox"
 className="rounded border-slate-300 text-indigo-500 focus:ring-indigo-500"
 checked={isSelected}
 onChange={(e) => {
 const current = [...(selectedDTEs[sId] || [])];
 let updated;
 if (e.target.checked) updated = [...current, dte];
 else updated = current.filter(d => d !== dte);
 setSelectedDTEs({ ...selectedDTEs, [sId]: updated });
 }}
 />
 <span className="text-[11px] font-medium text-slate-700">DTE {dte}</span>
 </label>
 <div className="flex items-center gap-0.5 ml-2 shrink-0">
 <button
 type="button"
 onClick={(e) => {
 e.stopPropagation();
 const newVal = Math.max(0, (typeof displayQty ==='number' ? displayQty : 1) - 1);
 setDteQuantities(prev => ({
 ...prev,
 [sId]: { ...(prev[sId] || {}), [dte]: newVal }
 }));
 }}
 className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 text-[11px] font-bold transition-colors leading-none"
 >−</button>
 <input
 type="number"
 min="0"
 step="0.5"
 value={displayQty}
 onClick={(e) => e.stopPropagation()}
 onChange={(e) => {
 e.stopPropagation();
 const val = e.target.value ==='' ?'' : parseFloat(e.target.value);
 setDteQuantities(prev => ({
 ...prev,
 [sId]: {
 ...(prev[sId] || {}),
 [dte]: val
 }
 }));
 }}
 onBlur={(e) => {
 if (e.target.value ==='') {
 // Reset to strategy default
 setDteQuantities(prev => {
 const updated = { ...prev, [sId]: { ...(prev[sId] || {}) } };
 delete updated[sId][dte];
 return updated;
 });
 }
 }}
 className="w-8 text-[11px] font-bold text-center outline-none bg-slate-50 border border-slate-200 text-indigo-600 focus:bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-400 rounded py-0.5 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
 />
 <button
 type="button"
 onClick={(e) => {
 e.stopPropagation();
 const newVal = (typeof displayQty ==='number' ? displayQty : 1) + 1;
 setDteQuantities(prev => ({
 ...prev,
 [sId]: { ...(prev[sId] || {}), [dte]: newVal }
 }));
 }}
 className="w-5 h-5 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 text-[11px] font-bold transition-colors leading-none"
 >+</button>
 </div>
 </div>
 );
 })}
 </div>
 </>
 )}
 </div>
 ) : (
 <div className="h-full px-2.5 flex items-center font-bold text-slate-700 bg-white rounded-l">
 <span className="max-w-[80px] truncate">{sName}</span>
 </div>
 )}

 <div className="w-[1px] h-4 bg-slate-200 shrink-0"></div>

 {/* Multiplier Input */}
 <div className="flex items-center h-full px-2.5 bg-slate-50 rounded-r border-l border-transparent group-hover/widget:border-slate-100 transition-colors">
 <span className="text-[9px] text-slate-400 font-bold mr-1.5 uppercase tracking-wide">Qty</span>
 <input
 type="number"
 min="0"
 step="0.5"
 value={strategyMultipliers[sId] !== undefined ? strategyMultipliers[sId] : 1}
 onChange={(e) => {
 const val = e.target.value ==='' ?'' : parseFloat(e.target.value);
 setStrategyMultipliers({ ...strategyMultipliers, [sId]: val });
 // Clear per-DTE overrides when strategy qty changes so they pick up the new default
 setDteQuantities(prev => {
 const updated = { ...prev };
 delete updated[sId];
 return updated;
 });
 }}
 onBlur={(e) => {
 if (e.target.value ==='') {
 setStrategyMultipliers({ ...strategyMultipliers, [sId]: 1 });
 }
 }}
 className="w-8 font-bold text-center outline-none bg-transparent text-indigo-600 focus:bg-white focus:ring-1 focus:ring-indigo-500 rounded py-0.5 transition-all"
 />
 <span className="text-[10px] text-slate-400 font-bold ml-0.5">x</span>
 </div>
 </div>
 );
 })}
 </div>
 </div>

 <div className="flex items-center justify-between mb-3 mt-8">
 <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
 <CalendarDays className="h-5 w-5 text-indigo-500" />
 Year-wise Returns
 </h2>
 </div>

 <div className="bg-white border border-slate-200 rounded-lg overflow-hidden overflow-x-auto mb-8">
 <table className="w-full text-[11px] text-left">
 <thead className="bg-slate-100/80 text-slate-500 font-medium text-[9px] uppercase tracking-wider border-b border-slate-200">
 <tr>
 <th className="px-3 py-2 font-semibold text-slate-700">Year</th>
 <th className="px-2 py-2 text-center">Jan</th>
 <th className="px-2 py-2 text-center">Feb</th>
 <th className="px-2 py-2 text-center">Mar</th>
 <th className="px-2 py-2 text-center">Apr</th>
 <th className="px-2 py-2 text-center">May</th>
 <th className="px-2 py-2 text-center">Jun</th>
 <th className="px-2 py-2 text-center">Jul</th>
 <th className="px-2 py-2 text-center">Aug</th>
 <th className="px-2 py-2 text-center">Sep</th>
 <th className="px-2 py-2 text-center">Oct</th>
 <th className="px-2 py-2 text-center">Nov</th>
 <th className="px-2 py-2 text-center">Dec</th>
 <th className="px-3 py-2 text-right font-semibold text-slate-700">Total</th>
 <th className="px-3 py-2 text-right text-rose-500/80">Max Drawdown</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {analytics.map(row => {


 const formatMoney = (val) => {
 if (!val || val === 0) return <span className="text-slate-300 font-bold">0</span>;
 return (
 <span className={val > 0 ?"text-emerald-600 font-bold" :"text-rose-600 font-bold"}>
 {Math.round(val).toLocaleString()}
 </span>
 );
 };

 return (
 <tr key={row.year} className="hover:bg-slate-50 transition-colors">
 <td className="px-3 py-2 font-black text-slate-800">{row.year}</td>
 {['01','02','03','04','05','06','07','08','09','10','11','12'].map(mm => (
 <td key={mm} className="px-2 py-2 text-center text-[10px]">
 {formatMoney(row.months[mm])}
 </td>
 ))}
 <td className="px-3 py-2 text-right">
 <span className={row.total > 0 ?"text-emerald-600 font-black text-[12px]" :"text-rose-600 font-black text-[12px]"}>
 {Math.round(row.total).toLocaleString()}
 </span>
 </td>
 <td className="px-3 py-2 text-right font-bold text-rose-500 text-[11px]">
 {Math.round(row.mdd).toLocaleString()}
 </td>
 </tr>
 );
 })}
 {analytics.length === 0 && (
 <tr>
 <td colSpan="15" className="px-4 py-8 text-center text-slate-400 font-medium">
 No backtest data available to calculate analytics.
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 {overallStats && (
 <div className="mt-8 mb-4">
 <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
 <Activity className="h-5 w-5 text-indigo-500" />
 Strategy Performance
 </h2>
 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
 {/* Column 1 */}
 <div className="bg-white border border-slate-200 rounded-lg overflow-hidden text-[11px]">
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Overall Profit</span>
 <span className={overallStats.totalPnL >= 0 ?"text-emerald-600 font-bold text-[12px]" :"text-rose-600 font-bold text-[12px]"}>₹{overallStats.totalPnL.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">No. of Trades</span>
 <span className="text-slate-800 font-bold">{overallStats.totalTrades}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Average Profit per Trade</span>
 <span className={overallStats.avgTrade >= 0 ?"text-emerald-600 font-bold" :"text-rose-600 font-bold"}>₹{overallStats.avgTrade.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Win %</span>
 <span className="text-slate-800 font-bold">{overallStats.winRate.toFixed(2)}%</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Loss %</span>
 <span className="text-slate-800 font-bold">{overallStats.lossRate.toFixed(2)}%</span>
 </div>
 <div className="flex justify-between items-center p-3">
 <span className="text-slate-600 font-medium">Average Profit on Winning Trades</span>
 <span className="text-emerald-600 font-bold">₹{overallStats.avgProfit.toFixed(2)}</span>
 </div>
 </div>

 {/* Column 2 */}
 <div className="bg-white border border-slate-200 rounded-lg overflow-hidden text-[11px]">
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Average Loss on Losing Trades</span>
 <span className="text-rose-600 font-bold">₹{overallStats.avgLoss.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Max Profit in Single Day</span>
 <div className="flex flex-col items-end">
 <span className="text-emerald-600 font-bold">₹{overallStats.maxProfit.toFixed(2)}</span>
 {overallStats.maxProfitDate && <span className="text-[9px] text-slate-400 font-medium">{new Date(overallStats.maxProfitDate).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</span>}
 </div>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Max Loss in Single Day</span>
 <div className="flex flex-col items-end">
 <span className="text-rose-600 font-bold">₹{overallStats.maxLoss.toFixed(2)}</span>
 {overallStats.maxLossDate && <span className="text-[9px] text-slate-400 font-medium">{new Date(overallStats.maxLossDate).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}</span>}
 </div>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Max Drawdown</span>
 <span className="text-rose-600 font-bold">₹{overallStats.maxDrawdown.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3">
 <span className="text-slate-600 font-medium">Duration of Max Drawdown</span>
 <span className="text-slate-800 font-bold text-right leading-tight">
 {overallStats.maxDrawdownDays}
 {overallStats.maxDrawdownStartDate && overallStats.maxDrawdownEndDate && (
 <span className="block text-[9px] text-slate-400 font-medium">
 [{new Date(overallStats.maxDrawdownStartDate).toLocaleDateString('en-GB', { day:'numeric', month:'numeric', year:'numeric' })} to {new Date(overallStats.maxDrawdownEndDate).toLocaleDateString('en-GB', { day:'numeric', month:'numeric', year:'numeric' })}]
 </span>
 )}
 </span>
 </div>
 </div>

 {/* Column 3 */}
 <div className="bg-white border border-slate-200 rounded-lg overflow-hidden text-[11px]">
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Yearly Return / MaxDD</span>
 <span className="text-slate-800 font-bold">{overallStats.returnOnMDD.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Reward to Risk Ratio</span>
 <span className="text-slate-800 font-bold">{overallStats.riskReward.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Expectancy Ratio</span>
 <span className="text-slate-800 font-bold">{overallStats.expectancyRatio.toFixed(2)}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Max Win Streak (days)</span>
 <span className="text-emerald-600 font-bold">{overallStats.maxWinStreak}</span>
 </div>
 <div className="flex justify-between items-center p-3 border-b border-slate-100">
 <span className="text-slate-600 font-medium">Max Losing Streak (days)</span>
 <span className="text-rose-600 font-bold">{overallStats.maxLoseStreak}</span>
 </div>
 <div className="flex justify-between items-center p-3">
 <span className="text-slate-600 font-medium">Max trades in any drawdown</span>
 <span className="text-slate-800 font-bold">{overallStats.maxDrawdownTrades}</span>
 </div>
 </div>
 </div>
 </div>
 )}
 <TradesSummaryTable trades={trades} filteredDailySummary={filteredDailySummary} strategy={strategy} availableStrategies={availableStrategies} selectedStrategies={selectedStrategies} />
 </div>
 ) : (
 <>
 <div className="px-4 py-3 border-b border-slate-100 flex justify-between items-center bg-slate-50/50 shrink-0">
 <div>
 <h4 className="text-[12px] font-bold text-slate-800 flex items-center gap-1.5 mb-0.5">
 <Clock className="h-3.5 w-3.5 text-indigo-500" />
 Market Data & Actions: {activeTab}
 </h4>
 {(() => {
 const activeSummary = typeof filteredDailySummary[activeTab] ==='object' ? filteredDailySummary[activeTab] : { pnl: 0, trade_value: 0, pnl_percent: 0 };
 const config = strategy?.config || {};
 const multiplier = parseFloat(config.quantity_multiplier) || 1;

 let overallSlStr = null;
 if (config.overall_sl_enabled && parseFloat(config.overall_sl_value) > 0) {
 const val = parseFloat(config.overall_sl_value);
 overallSlStr = config.overall_sl_type ==='AMOUNT' ?`₹${(val * multiplier).toLocaleString()}` :`${val}%`;
 }

 let overallTgtStr = null;
 if (config.overall_target_enabled && parseFloat(config.overall_target_value) > 0) {
 const val = parseFloat(config.overall_target_value);
 overallTgtStr = config.overall_target_type ==='AMOUNT' ?`₹${(val * multiplier).toLocaleString()}` :`${val}%`;
 }

 let earlyProfitStr = null;
 if (earlyProfitValue !=='' && parseFloat(earlyProfitValue) > 0) {
 const val = parseFloat(earlyProfitValue);
 const time = earlyProfitTime ? earlyProfitTime.substring(0, 5) :'??:??';
 earlyProfitStr =`₹${val.toLocaleString()} before ${time}`;
 }

 return (
 <div className="flex items-center gap-3 text-[10px] text-slate-500">
 <span>Trade Value: <strong className="text-slate-700">₹{Math.round(activeSummary.trade_value || 0).toLocaleString()}</strong></span>
 {overallSlStr && <span>• Target SL: <strong className="text-rose-600">{overallSlStr}</strong></span>}
 {overallTgtStr && <span>• Target Profit: <strong className="text-emerald-600">{overallTgtStr}</strong></span>}
 {earlyProfitStr && <span>• Early Exit: <strong className="text-blue-600">{earlyProfitStr}</strong></span>}
 </div>
 );
 })()}
 </div>
 <div className="flex items-center gap-4 text-right">
 <div className="flex items-center gap-1 bg-slate-100/80 rounded-md p-1 border border-slate-200">
 <button
 onClick={() => setZoomLevel(z => Math.max(50, z - 10))}
 className="p-1 hover:bg-white rounded text-slate-500 hover:text-slate-700 transition-colors"
 title="Zoom Out"
 >
 <ZoomOut className="w-3.5 h-3.5" />
 </button>
 <span className="text-[10px] font-mono font-bold text-slate-600 w-8 text-center">{zoomLevel}%</span>
 <button
 onClick={() => setZoomLevel(z => Math.min(200, z + 10))}
 className="p-1 hover:bg-white rounded text-slate-500 hover:text-slate-700 transition-colors"
 title="Zoom In"
 >
 <ZoomIn className="w-3.5 h-3.5" />
 </button>
 </div>
 <div>
 <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-0.5">Daily Result</div>
 {(() => {
 const daySummary = typeof filteredDailySummary[activeTab] ==='object' ? filteredDailySummary[activeTab] : { pnl: 0, pnl_percent: 0 };
 const dayPnL = daySummary.pnl || 0;
 const pnlPercent = daySummary.pnl_percent || 0;
 const isDayProfitable = dayPnL >= 0;
 return (
 <div className={`text-sm font-black ${isDayProfitable ?'text-emerald-500' :'text-rose-500'} flex items-center justify-end gap-1.5`}>
 ₹{dayPnL.toFixed(2)}
 <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 font-bold ml-1 text-slate-600">
 {isDayProfitable ?'+' :''}{pnlPercent.toFixed(2)}%
 </span>
 </div>
 );
 })()}
 </div>
 </div>
 </div>
 <div className="flex-1 overflow-auto p-0 relative custom-scrollbar bg-white">
 {Object.keys(chartData && chartData[activeTab] ? chartData[activeTab] : {}).length > 0 ? (() => {
 const daySummaryRaw = typeof dailySummary[activeTab] ==='object' ? dailySummary[activeTab] : {};
 let dayTradeValue = 0;
 const activeStrategyKeys = new Set();

 // Build stratDteMap for this day
 const stratDteMap = {};
 if (daySummaryRaw.strategies) {
 Object.entries(daySummaryRaw.strategies).forEach(([sId, sData]) => {
 stratDteMap[sId] = sData.dte;
 if (selectedStrategies.has(sId)) {
 const dteFilters = selectedDTEs[sId] || [];
 if (dteFilters.length === 0 || dteFilters.includes(sData.dte)) {
 dayTradeValue += (sData.trade_value || 0) * getEffectiveMultiplier(sId, sData.dte);
 activeStrategyKeys.add(sId);
 }
 }
 });
 } else {
 const sId = strategy?.id ||'single';
 stratDteMap[sId] = daySummaryRaw.dte;
 if (selectedStrategies.has(sId)) {
 const dteFilters = selectedDTEs[sId] || [];
 if (dteFilters.length === 0 || dteFilters.includes(daySummaryRaw.dte)) {
 dayTradeValue += (daySummaryRaw.trade_value || 0) * getEffectiveMultiplier(sId, daySummaryRaw.dte);
 activeStrategyKeys.add(sId);
 }
 }
 }

 const legs = Object.keys(chartData[activeTab]).filter(k => k !=='OVERALL_PNL');
 const strategyGroups = {};
 legs.forEach(leg => {
 const sId = strategy?.isCombined ? leg.split('_')[0] : (strategy?.id ||'single');
 if (activeStrategyKeys.has(sId)) {
 if (!strategyGroups[sId]) strategyGroups[sId] = [];
 strategyGroups[sId].push(leg);
 }
 });

 const formatLegName = (legKey) => {
 if (!strategy?.isCombined) return legKey;
 const sId = legKey.split('_')[0];
 const strat = availableStrategies.find(s => String(s.id) === String(sId));
 if (strat && strat.name) {
 return legKey.replace(sId, strat.name);
 }
 return legKey;
 };

 let portfolioHitTime = null;
 let portfolioHitAction = null;
 let timeMapOverall = {};

 const allTimes = new Set();
 const legTimeMap = {};
 for (const [key, tickArray] of Object.entries(chartData[activeTab])) {
 const sIdForMap = strategy?.isCombined ? key.split('_')[0] : (strategy?.id ||'single');
 if (key !=='OVERALL_PNL' && activeStrategyKeys.has(sIdForMap) && Array.isArray(tickArray)) {
 legTimeMap[key] = {};
 tickArray.forEach(t => {
 if (t && t.time) {
 allTimes.add(t.time);
 legTimeMap[key][t.time] = t.pnl;
 }
 });
 }
 }

 const sortedTimes = Array.from(allTimes).sort();
 const legLastPnL = {};
 const timeMapStrategy = {};
 Object.keys(strategyGroups).forEach(sId => timeMapStrategy[sId] = {});

 sortedTimes.forEach(t => {
 let totalAtTime = 0;
 Object.keys(strategyGroups).forEach(sId => {
 let stratTotal = 0;
 const multi = getEffectiveMultiplier(sId, stratDteMap[sId]);
 strategyGroups[sId].forEach(key => {
 if (legTimeMap[key][t] !== undefined) legLastPnL[key] = legTimeMap[key][t];
 stratTotal += ((legLastPnL[key] || 0) * multi);
 });
 timeMapStrategy[sId][t] = stratTotal;
 totalAtTime += stratTotal;
 });
 timeMapOverall[t] = totalAtTime;
 });

 if (portfolioMaxLoss !=='' || portfolioTarget !=='' || earlyProfitValue !=='') {
 const maxL = parseFloat(portfolioMaxLoss);
 const maxT = parseFloat(portfolioTarget);
 const limitSL = portfolioRiskType ==='PERCENT' && !isNaN(maxL) ? (dayTradeValue * maxL / 100) : maxL;
 const limitTarget = portfolioRiskType ==='PERCENT' && !isNaN(maxT) ? (dayTradeValue * maxT / 100) : maxT;

 const earlyVal = parseFloat(earlyProfitValue);
 const earlyTime = earlyProfitTime ? earlyProfitTime.substring(0, 5) :'';

 const times = Object.keys(timeMapOverall).sort();
 for (const t of times) {
 const pnlAtTime = timeMapOverall[t];
 if (!isNaN(limitSL) && limitSL > 0 && pnlAtTime <= -limitSL) {
 portfolioHitTime = t;
 portfolioHitAction ='PORTFOLIO_SL_HIT';
 break;
 }
 if (!isNaN(limitTarget) && limitTarget > 0 && pnlAtTime >= limitTarget) {
 portfolioHitTime = t;
 portfolioHitAction ='PORTFOLIO_TARGET_HIT';
 break;
 }
 if (!isNaN(earlyVal) && earlyVal > 0 && earlyTime && t < earlyTime && pnlAtTime >= earlyVal) {
 portfolioHitTime = t;
 portfolioHitAction ='EARLY_PROFIT_EXIT';
 break;
 }
 }
 }

 const strategyHitTime = {};
 const strategyHitAction = {};

 Object.entries(strategyGroups).forEach(([sId, sLegs]) => {
 let hitTime = null;
 let hitAction = null;

 for (const leg of sLegs) {
 const legData = chartData[activeTab]?.[leg] || [];
 for (const node of legData) {
 if (node.action) {
 if (node.action.includes('[OVER_SL]')) {
 if (!hitTime || node.time < hitTime) {
 hitTime = node.time;
 hitAction ='STRATEGY_SL_HIT';
 }
 } else if (node.action.includes('[OVER_TGT]')) {
 if (!hitTime || node.time < hitTime) {
 hitTime = node.time;
 hitAction ='STRATEGY_TARGET_HIT';
 }
 }
 }
 }
 }

 if (hitTime) {
 strategyHitTime[sId] = hitTime;
 strategyHitAction[sId] = hitAction;
 }
 });

 return (
 <table className="w-full text-left border-collapse min-w-max" style={{ zoom: zoomLevel / 100 }}>
 <thead className="text-[9px] uppercase tracking-wider text-slate-500">
 <tr>
 <th rowSpan={2} className="sticky left-0 top-0 z-40 px-3 py-2 font-bold border-b border-r border-slate-200 text-center align-middle bg-slate-200 )]">
 Time
 </th>
 {Object.entries(strategyGroups).map(([sId, sLegs]) => {
 const strat = availableStrategies.find(s => String(s.id) === String(sId));
 const stratNameLabel = strat ? strat.name : sId;
 return (
 <React.Fragment key={`strat-group-${sId}`}>
 {sLegs.map(leg => (
 <th key={leg} colSpan={6} className="sticky top-0 z-20 px-2 py-1.5 font-extrabold border-b border-r border-slate-200 text-center text-slate-700 bg-slate-100 )]">
 <span className={leg.includes('CE') ?'text-emerald-600' :'text-rose-600'}>{formatLegName(leg)}</span>
 </th>
 ))}
 <th colSpan={2} className="sticky top-0 z-20 px-2 py-1.5 font-extrabold border-b border-r border-slate-200 text-center text-indigo-700 bg-indigo-50 )]">
 {stratNameLabel} Overall
 </th>
 </React.Fragment>
 );
 })}
 <th colSpan={2} className="sticky right-0 top-0 z-40 px-3 py-2 font-bold border-b border-slate-200 text-center align-middle bg-slate-200 )] text-slate-700">
 Overall Portfolio
 </th>
 </tr>
 <tr>
 {Object.entries(strategyGroups).map(([sId, sLegs]) => (
 <React.Fragment key={`strat-sub-${sId}`}>
 {sLegs.map(leg => (
 <React.Fragment key={`${leg}-sub`}>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-slate-200 text-right bg-slate-50 )]">Open</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-slate-200 text-right bg-slate-50 )]">High</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-slate-200 text-right bg-slate-50 )]">Low</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-slate-200 text-right bg-slate-50 )]">Close</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-slate-200 text-right bg-slate-50 )]">PnL</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-r border-slate-200 bg-slate-50 )]">Action</th>
 </React.Fragment>
 ))}
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-r border-indigo-100 text-right bg-indigo-50 text-indigo-700 )]">Total PnL</th>
 <th className="sticky top-[29px] z-20 px-2 py-1 font-semibold border-b border-r border-indigo-100 text-center bg-indigo-50 text-indigo-700 )]">Action</th>
 </React.Fragment>
 ))}
 <th className="sticky right-[110px] top-[29px] z-40 px-3 py-1 font-semibold border-b border-r border-slate-200 text-right bg-slate-100 )]">PnL</th>
 <th className="sticky right-0 top-[29px] z-40 px-3 py-1 min-w-[110px] max-w-[110px] w-[110px] font-semibold border-b border-slate-200 text-center bg-slate-100 )]">Action</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 text-[10px]">
 {(portfolioHitTime ? sortedTimes.slice(0, sortedTimes.indexOf(portfolioHitTime) + 1) : sortedTimes).map((time, idx) => {
 let timeStr = time?.includes('T') ? time.substring(11, 19) : time?.substring(0, 8) ||'-';
 const actualOverallPnL = timeMapOverall[time] !== undefined ? timeMapOverall[time] : 0;

 const isSecondData = !timeStr.endsWith(':00');
 const rowClass = isSecondData ?'bg-slate-100 hover:bg-slate-200/80' :'hover:bg-indigo-50/40';
 const tdClass = isSecondData ?'bg-slate-200 group-hover:bg-slate-300' :'bg-slate-50 group-hover:bg-indigo-50';

 return (
 <tr key={idx} className={`${rowClass} transition-colors group`}>
 <td className={`sticky left-0 z-20 px-3 py-1 font-semibold text-slate-600 tabular-nums border-r border-slate-100 text-center ${tdClass}`}>
 {timeStr}
 </td>
 {Object.entries(strategyGroups).map(([sId, sLegs]) => {
 const actualStratPnL = timeMapStrategy[sId][time] || 0;
 return (
 <React.Fragment key={`strat-row-${sId}-${idx}`}>
 {sLegs.map(leg => {
 const legData = chartData[activeTab][leg];
 const legRow = legData ? legData.find(r => r.time === time) : null;
 if (!legRow) return <td colSpan={6} key={`${leg}-${idx}`} className="border-r border-slate-100 bg-slate-50/30"></td>;
 return (
 <React.Fragment key={`${leg}-${idx}`}>
 <td className="px-2 py-1 text-right font-mono text-slate-500">{legRow.open?.toFixed(2)}</td>
 <td className="px-2 py-1 text-right font-mono text-emerald-600/80">{legRow.high?.toFixed(2)}</td>
 <td className="px-2 py-1 text-right font-mono text-rose-600/80">{legRow.low?.toFixed(2)}</td>
 <td className="px-2 py-1 text-right font-mono font-bold text-slate-800">{legRow.close?.toFixed(2)}</td>
 <td className="px-2 py-1 text-right font-mono font-bold">
 <span className={legRow.pnl > 0 ?"text-emerald-600" : legRow.pnl < 0 ?"text-rose-600" :"text-slate-400"}>
 {legRow.pnl > 0 ?'+' :''}{legRow.pnl?.toFixed(2) ||'0.00'}
 </span>
 </td>
 <td className="px-2 py-1 border-r border-slate-100">
 {legRow.action ? (
 <span className="text-indigo-700 bg-indigo-100/60 px-1.5 py-0.5 rounded text-[9px] inline-block ring-1 ring-indigo-200/50 font-medium whitespace-pre-wrap break-words" title={legRow.action}>
 {legRow.action}
 </span>
 ) : <span className="text-slate-300">-</span>}
 </td>
 </React.Fragment>
 );
 })}
 <td className="px-2 py-1 border-r border-indigo-100 text-right font-mono font-black bg-indigo-50/30 group-hover:bg-indigo-100/40 text-[11px]">
 <span className={actualStratPnL > 0 ?"text-emerald-600" : actualStratPnL < 0 ?"text-rose-600" :"text-slate-400"}>
 {actualStratPnL > 0 ?'+' :''}{actualStratPnL.toFixed(2)}
 </span>
 </td>
 <td className="px-2 py-1 border-r border-indigo-100 text-center bg-indigo-50/30 group-hover:bg-indigo-100/40">
 {time === strategyHitTime[sId] ? (
 <span className={`text-white px-1.5 py-0.5 rounded text-[9px] inline-block font-bold whitespace-nowrap ${strategyHitAction[sId] ==='STRATEGY_TARGET_HIT' ?'bg-emerald-500' :'bg-rose-500'}`}>
 {strategyHitAction[sId] ==='STRATEGY_TARGET_HIT' ?'TGT HIT' :'SL HIT'}
 </span>
 ) : <span className="text-indigo-200/50">-</span>}
 </td>
 </React.Fragment>
 );
 })}
 <td className="sticky right-[110px] z-20 px-3 py-1 text-right border-l border-r border-slate-200 font-mono font-black bg-slate-50 group-hover:bg-indigo-50 text-[11px] )]">
 <span className={actualOverallPnL > 0 ?"text-emerald-600" : actualOverallPnL < 0 ?"text-rose-600" :"text-slate-400"}>
 {actualOverallPnL > 0 ?'+' :''}{actualOverallPnL.toFixed(2)}
 </span>
 </td>
 <td className="sticky right-0 z-20 px-3 py-1 min-w-[110px] max-w-[110px] w-[110px] text-center bg-slate-50 group-hover:bg-indigo-50">
 {time === portfolioHitTime ? (
 <span className={`text-white px-1.5 py-0.5 rounded text-[9px] inline-block font-bold whitespace-nowrap ${portfolioHitAction ==='PORTFOLIO_TARGET_HIT' ?'bg-emerald-500' : portfolioHitAction ==='EARLY_PROFIT_EXIT' ?'bg-blue-500' :'bg-rose-500'}`}>
 {portfolioHitAction ==='EARLY_PROFIT_EXIT' ?'EARLY EXIT' : portfolioHitAction}
 </span>
 ) : (
 <span className="text-slate-300">-</span>
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 );
 })() : (
 <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm font-medium">
 No options data available for this date.
 </div>
 )}
 </div>
 </>
 )}
 </div>
 </div>

 <StrategyConfigModal
 isOpen={isConfigModalOpen}
 onClose={() => setIsConfigModalOpen(false)}
 strategy={strategy}
 />
 </div>
 );
};
