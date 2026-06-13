import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Download, ChevronsUpDown } from 'lucide-react';
import * as XLSX from 'xlsx';

export const TradesSummaryTable = ({ trades = [], filteredDailySummary = {}, strategy, availableStrategies = [], selectedStrategies }) => {
    // Helper: check if a trade belongs to one of the selected strategies
    const isTradeSelected = (trade) => {
        if (!selectedStrategies || selectedStrategies.size === 0) return true;
        if (!strategy?.isCombined) {
            // Single strategy: check if the strategy id is selected
            const sId = strategy?.id || 'single';
            return selectedStrategies.has(sId);
        }
        // Combined strategy: extract strategy id from leg_id
        if (!trade.leg_id) return true;
        const sId = trade.leg_id.split('_')[0];
        return selectedStrategies.has(sId);
    };
    const getStrategyName = (legId) => {
        if (!strategy?.isCombined) return strategy?.name || 'Strategy';
        if (!legId) return 'Strategy';
        const sId = legId.split('_')[0];
        const strat = availableStrategies.find(s => String(s.id) === String(sId));
        return strat?.name || sId;
    };

    // We group the trades by date, filtering by selected strategies
    const tradesByDate = {};
    trades.forEach(t => {
        if (!isTradeSelected(t)) return;
        if (!tradesByDate[t.date]) tradesByDate[t.date] = [];
        tradesByDate[t.date].push(t);
    });

    // Only show dates that are present in filteredDailySummary
    const sortedDates = Object.keys(filteredDailySummary).sort((a, b) => b.localeCompare(a));

    const [expandedDates, setExpandedDates] = useState(new Set());
    const [currentPage, setCurrentPage] = useState(1);
    const rowsPerPage = 20;

    React.useEffect(() => {
        setCurrentPage(1);
    }, [filteredDailySummary]);

    const toggleRow = (date) => {
        const newSet = new Set(expandedDates);
        if (newSet.has(date)) newSet.delete(date);
        else newSet.add(date);
        setExpandedDates(newSet);
    };

    if (sortedDates.length === 0) return null;

    const totalPages = Math.ceil(sortedDates.length / rowsPerPage);
    const currentDates = sortedDates.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

    const isAllExpandedOnPage = currentDates.length > 0 && currentDates.every(d => expandedDates.has(d));

    const handleExpandAll = () => {
        const newSet = new Set(expandedDates);
        if (isAllExpandedOnPage) {
            currentDates.forEach(d => newSet.delete(d));
        } else {
            currentDates.forEach(d => newSet.add(d));
        }
        setExpandedDates(newSet);
    };

    const handleExportExcel = () => {
        const exportData = [];

        sortedDates.forEach((date, index) => {
            const summary = typeof filteredDailySummary[date] === 'object' ? filteredDailySummary[date] : { pnl: filteredDailySummary[date] };
            const dayTrades = tradesByDate[date] || [];
            const overallPnL = summary.pnl || 0;

            let firstEntry = '-';
            let lastExit = '-';
            if (dayTrades.length > 0) {
                const sortedT = [...dayTrades].sort((a, b) => a.entry_time.localeCompare(b.entry_time));
                firstEntry = sortedT[0].entry_time;
                const sortedE = [...dayTrades].sort((a, b) => {
                    if (!a.exit_time) return 1;
                    if (!b.exit_time) return -1;
                    return b.exit_time.localeCompare(a.exit_time);
                });
                lastExit = sortedE[0].exit_time || '-';
            }

            exportData.push({
                'Row Index': `${index + 1}`,
                'Row Type': 'Strategy Overall',
                'Entry Date': date,
                'Entry Time': firstEntry,
                'Exit Date': date,
                'Exit Time': lastExit,
                'Strategy': strategy?.name || 'Combined Strategy',
                'Option Type': '-',
                'Strike': '-',
                'Buy/Sell': '-',
                'Qty': '-',
                'Entry Price': '-',
                'Exit Price': '-',
                'PnL': Math.round(overallPnL),
                'Exit Reason': '-'
            });

            dayTrades.forEach((t, idx) => {
                const typeMatch = t.symbol ? t.symbol.split('_') : [];
                const strike = typeMatch[0] || '-';
                const optType = typeMatch[1] || '-';

                exportData.push({
                    'Row Index': `${index + 1}.${idx + 1}`,
                    'Row Type': 'Trade',
                    'Entry Date': t.date,
                    'Entry Time': t.entry_time,
                    'Exit Date': t.date,
                    'Exit Time': t.exit_time || '-',
                    'Strategy': getStrategyName(t.leg_id),
                    'Option Type': optType,
                    'Strike': strike,
                    'Buy/Sell': t.side,
                    'Qty': t.qty,
                    'Entry Price': t.entry_price ? Number(t.entry_price.toFixed(2)) : 0,
                    'Exit Price': t.exit_price ? Number(t.exit_price.toFixed(2)) : 0,
                    'PnL': Math.round(t.pnl || 0),
                    'Exit Reason': t.exit_reason || '-'
                });
            });
        });

        const worksheet = XLSX.utils.json_to_sheet(exportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Trades Summary");
        XLSX.writeFile(workbook, "trades_summary.xlsx");
    };

    return (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mt-6">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
                <div>
                    <h3 className="text-[12px] font-bold text-slate-700 uppercase tracking-wider">Trades Summary</h3>
                    <div className="text-[10px] text-slate-500 font-medium mt-0.5">Grouped by Date</div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleExpandAll}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-bold border border-slate-200 rounded-md shadow-sm transition-colors"
                    >
                        <ChevronsUpDown className="w-3.5 h-3.5" />
                        {isAllExpandedOnPage ? 'Collapse All' : 'Expand All'}
                    </button>
                    <button
                        onClick={handleExportExcel}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-bold border border-slate-200 rounded-md shadow-sm transition-colors"
                    >
                        <Download className="w-3.5 h-3.5" />
                        Export to Excel
                    </button>
                </div>
            </div>
            <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-[11px] text-left">
                    <thead className="bg-slate-50/50 text-slate-500 font-bold uppercase tracking-wider sticky top-0">
                        <tr>
                            <th className="px-4 py-2 border-b border-slate-200 w-8"></th>
                            <th className="px-3 py-2 border-b border-slate-200">Entry Date</th>
                            <th className="px-3 py-2 border-b border-slate-200">Entry Time</th>
                            <th className="px-3 py-2 border-b border-slate-200">Exit Date</th>
                            <th className="px-3 py-2 border-b border-slate-200">Exit Time</th>
                            <th className="px-3 py-2 border-b border-slate-200">Strategy</th>
                            <th className="px-3 py-2 border-b border-slate-200">Type</th>
                            <th className="px-3 py-2 border-b border-slate-200">Strike</th>
                            <th className="px-3 py-2 border-b border-slate-200">Buy/Sell</th>
                            <th className="px-3 py-2 border-b border-slate-200 text-right">Qty</th>
                            <th className="px-3 py-2 border-b border-slate-200 text-right">Entry Price</th>
                            <th className="px-3 py-2 border-b border-slate-200 text-right">Exit Price</th>
                            <th className="px-4 py-2 border-b border-slate-200 text-right">PnL</th>
                            <th className="px-3 py-2 border-b border-slate-200">Exit Reason</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {currentDates.map((date, index) => {
                            const globalIndex = (currentPage - 1) * rowsPerPage + index;
                            const summary = typeof filteredDailySummary[date] === 'object' ? filteredDailySummary[date] : { pnl: filteredDailySummary[date] };
                            const dayTrades = tradesByDate[date] || [];
                            const isExpanded = expandedDates.has(date);
                            const overallPnL = summary.pnl || 0;

                            // Find overall entry/exit times
                            let firstEntry = '-';
                            let lastExit = '-';
                            if (dayTrades.length > 0) {
                                // sort by entry time
                                const sortedT = [...dayTrades].sort((a, b) => a.entry_time.localeCompare(b.entry_time));
                                firstEntry = sortedT[0].entry_time;
                                // sort by exit time
                                const sortedE = [...dayTrades].sort((a, b) => {
                                    if (!a.exit_time) return 1;
                                    if (!b.exit_time) return -1;
                                    return b.exit_time.localeCompare(a.exit_time);
                                });
                                lastExit = sortedE[0].exit_time || '-';
                            }

                            return (
                                <React.Fragment key={date}>
                                    <tr
                                        className="hover:bg-slate-50 transition-colors cursor-pointer group"
                                        onClick={() => toggleRow(date)}
                                    >
                                        <td className="px-4 py-2 text-slate-400 group-hover:text-indigo-600 transition-colors flex items-center gap-1.5">
                                            {isExpanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                                            <span className="text-[10px] font-bold text-slate-400">{globalIndex + 1}</span>
                                        </td>
                                        <td className="px-3 py-2 font-bold text-slate-700">{date}</td>
                                        <td className="px-3 py-2 font-medium text-slate-600">{firstEntry}</td>
                                        <td className="px-3 py-2 font-bold text-slate-700">{date}</td>
                                        <td className="px-3 py-2 font-medium text-slate-600">{lastExit}</td>
                                        <td className="px-3 py-2 text-slate-400 font-medium truncate max-w-[100px]">{strategy?.name || 'Combined Strategy'}</td>
                                        <td className="px-3 py-2 text-slate-400">-</td>
                                        <td className="px-3 py-2 text-slate-400">-</td>
                                        <td className="px-3 py-2 text-slate-400">-</td>
                                        <td className="px-3 py-2 text-slate-400 text-right">-</td>
                                        <td className="px-3 py-2 text-slate-400 text-right">-</td>
                                        <td className="px-3 py-2 text-slate-400 text-right">-</td>
                                        <td className={`px-4 py-2 font-bold text-right ${overallPnL >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                            {overallPnL > 0 ? '+' : ''}₹{Math.round(overallPnL).toLocaleString()}
                                        </td>
                                        <td className="px-3 py-2 text-slate-400">-</td>
                                    </tr>

                                    {isExpanded && dayTrades.map((t, idx) => {
                                        // Match the type/strike
                                        const typeMatch = t.symbol ? t.symbol.split('_') : [];
                                        const strike = typeMatch[0] || '-';
                                        const optType = typeMatch[1] || '-';

                                        return (
                                            <tr key={`${date}-${idx}`} className="bg-slate-50/50 hover:bg-slate-100 transition-colors">
                                                <td className="px-4 py-1.5 text-slate-300 text-right text-[9px] font-bold">{globalIndex + 1}.{idx + 1}</td>
                                                <td className="px-3 py-1.5 text-slate-500">{t.date}</td>
                                                <td className="px-3 py-1.5 text-slate-600 font-medium">{t.entry_time}</td>
                                                <td className="px-3 py-1.5 text-slate-500">{t.date}</td>
                                                <td className="px-3 py-1.5 text-slate-600 font-medium">{t.exit_time || '-'}</td>
                                                <td className="px-3 py-1.5 text-slate-600 font-medium truncate max-w-[100px]" title={getStrategyName(t.leg_id)}>{getStrategyName(t.leg_id)}</td>
                                                <td className={`px-3 py-1.5 font-bold ${optType === 'CE' ? 'text-emerald-600' : (optType === 'PE' ? 'text-rose-600' : 'text-slate-500')}`}>{optType}</td>
                                                <td className="px-3 py-1.5 text-slate-700 font-bold">{strike}</td>
                                                <td className={`px-3 py-1.5 font-bold ${t.side === 'BUY' ? 'text-indigo-600' : 'text-amber-600'}`}>{t.side}</td>
                                                <td className="px-3 py-1.5 text-slate-700 text-right font-medium">{t.qty}</td>
                                                <td className="px-3 py-1.5 text-slate-700 text-right">₹{t.entry_price?.toFixed(2) || '0.00'}</td>
                                                <td className="px-3 py-1.5 text-slate-700 text-right">
                                                    {t.exit_price ? `₹${t.exit_price.toFixed(2)}` : '-'}
                                                </td>
                                                <td className={`px-4 py-1.5 font-bold text-right ${(t.pnl || 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                    {(t.pnl || 0) > 0 ? '+' : ''}₹{Math.round(t.pnl || 0).toLocaleString()}
                                                </td>
                                                <td className="px-3 py-1.5 text-slate-500 font-medium text-[10px] uppercase tracking-wider">{t.exit_reason || '-'}</td>
                                            </tr>
                                        );
                                    })}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
                    <div className="text-[11px] text-slate-500 font-medium">
                        Showing <span className="font-bold text-slate-700">{(currentPage - 1) * rowsPerPage + 1}</span> to <span className="font-bold text-slate-700">{Math.min(currentPage * rowsPerPage, sortedDates.length)}</span> of <span className="font-bold text-slate-700">{sortedDates.length}</span> days
                    </div>
                    <div className="flex items-center gap-1">
                        <button
                            disabled={currentPage === 1}
                            onClick={() => setCurrentPage(p => p - 1)}
                            className="px-2.5 py-1 text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Previous
                        </button>
                        <div className="px-3 py-1 text-[11px] font-bold text-slate-700 bg-slate-100 border border-slate-200 rounded">
                            {currentPage} / {totalPages}
                        </div>
                        <button
                            disabled={currentPage === totalPages}
                            onClick={() => setCurrentPage(p => p + 1)}
                            className="px-2.5 py-1 text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
