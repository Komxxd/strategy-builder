import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
    History as HistoryIcon, 
    Search, 
    Calendar, 
    ChevronRight, 
    ExternalLink, 
    ShieldCheck, 
    Zap,
    TrendingUp,
    TrendingDown,
    Activity,
    Clock,
    Settings2,
    MessageSquare,
    FilterX,
    Loader2
} from 'lucide-react';
import axios from 'axios';
import { StrategyLogs } from './StrategyLogs';
import { StrategyConfigModal } from './StrategyConfigModal';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

export const StrategyHistory = () => {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterType, setFilterType] = useState('ALL'); // ALL, PAPER, LIVE
    
    // Modal states
    const [selectedLogs, setSelectedLogs] = useState(null);
    const [selectedConfig, setSelectedConfig] = useState(null);
    const [expandedHistory, setExpandedHistory] = useState({});

    const fetchHistory = async () => {
        try {
            setLoading(true);
            const res = await axios.get(`${API_BASE_URL}/strategy/history`);
            if (res.data.success) {
                setHistory(res.data.data);
            }
        } catch (err) {
            console.error("Error fetching history:", err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchHistory();
    }, []);

    const filteredHistory = history.filter(item => {
        const matchesSearch = item.name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                             item.id?.toLowerCase().includes(searchTerm.toLowerCase());
        
        const isPaper = item.config?.is_paper_trading;
        const matchesType = filterType === 'ALL' || 
                           (filterType === 'PAPER' && isPaper) || 
                           (filterType === 'LIVE' && !isPaper);
        
        return matchesSearch && matchesType;
    });

    const formatDate = (dateStr) => {
        if (!dateStr) return '---';
        const date = new Date(dateStr);
        return new Intl.DateTimeFormat('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }).format(date);
    };

    if (loading && history.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Loading Execution History...</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 animate-in fade-in duration-500">
            {/* Header Controls */}
            <div className="flex flex-col md:flex-row gap-3 items-center justify-between bg-white p-2.5 rounded-lg border border-slate-100 shadow-sm">
                <div className="relative w-full md:w-80">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <input 
                        type="text"
                        placeholder="Search by strategy name or ID..."
                        className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border-none rounded-md text-xs focus:ring-2 focus:ring-primary/20 transition-all outline-none font-medium"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                <div className="flex items-center gap-1.5 bg-slate-50 p-0.5 rounded-lg w-full md:w-auto">
                    {[
                        { id: 'ALL', label: 'All Trades' },
                        { id: 'LIVE', label: 'Live' },
                        { id: 'PAPER', label: 'Paper' }
                    ].map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setFilterType(t.id)}
                            className={`flex-1 md:flex-none px-3 py-1 rounded-md text-[10px] font-bold transition-all ${
                                filterType === t.id 
                                ? 'bg-white text-slate-900 shadow-sm' 
                                : 'text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* History Grid Container */}
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm">
                {/* Desktop Header */}
                <div className="hidden lg:grid lg:grid-cols-12 gap-4 px-4 py-2 bg-muted/50 text-black border-b text-[10px] font-black uppercase tracking-wider items-center">
                    <div className="col-span-3">Strategy Name</div>
                    <div className="col-span-2">Executed At</div>
                    <div className="col-span-2 text-center">Index / Mode</div>
                    <div className="col-span-2 text-right">Final PnL</div>
                    <div className="col-span-3 text-right">Actions</div>
                </div>

                <div className="divide-y divide-slate-100 flex flex-col">
                    {filteredHistory.length === 0 ? (
                        <div className="p-12 flex flex-col items-center justify-center text-center bg-slate-50/30">
                            <FilterX className="h-8 w-8 text-slate-200 mb-3" />
                            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">No matching history found</h3>
                        </div>
                    ) : (
                        filteredHistory.map((item) => (
                            <div key={item.id} className="flex flex-col">
                                {/* Main Row */}
                                <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 lg:gap-4 px-4 py-2.5 items-center hover:bg-slate-50/80 transition-colors group cursor-default">
                                    {/* Name Column */}
                                    <div className="col-span-1 lg:col-span-3">
                                        <div className="font-black text-black text-[11px] truncate" title={item.name}>
                                            {item.name}
                                        </div>
                                        <div className="text-[9px] font-mono text-black/60 mt-0.5 flex items-center gap-1.5">
                                            <span>#{item.id.split('-')[0]}</span>
                                            <span className={`px-1 rounded-[4px] uppercase font-black tracking-tighter scale-90 ${
                                                item.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-600' : 
                                                item.status === 'FAILED' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500'
                                            }`}>
                                                {item.status}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Date Column */}
                                    <div className="col-span-1 lg:col-span-2 text-[10px] font-bold text-black flex lg:block items-center justify-between">
                                        <span className="lg:hidden uppercase text-[9px] text-black/60">Date</span>
                                        <span>{formatDate(item.started_at)}</span>
                                    </div>

                                    {/* Index Column */}
                                    <div className="col-span-1 lg:col-span-2 flex lg:block items-center justify-between text-center">
                                        <span className="lg:hidden uppercase text-[9px] text-black/60">Setup</span>
                                        <div className="flex items-center justify-center gap-1.5">
                                            <span className="text-[10px] font-black text-black">{item.config?.index}</span>
                                            <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded border ${
                                                item.config?.is_paper_trading 
                                                ? 'border-blue-100 bg-blue-50 text-blue-600' 
                                                : 'border-orange-100 bg-orange-50 text-orange-600'
                                            }`}>
                                                {item.config?.is_paper_trading ? 'Paper' : 'Live'}
                                            </span>
                                        </div>
                                    </div>

                                    {/* PnL Column */}
                                    <div className="col-span-1 lg:col-span-2 text-right flex lg:block items-center justify-between">
                                        <span className="lg:hidden uppercase text-[9px] text-slate-400">Total PnL</span>
                                        <div className={`font-mono font-bold text-[11px] ${item.totalPnlRupees >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                            ₹{Number(item.totalPnlRupees || 0).toFixed(0)} 
                                            <span className="ml-1 opacity-70 text-[9px]">({Number(item.pnlPercent || 0).toFixed(2)}%)</span>
                                        </div>
                                    </div>

                                    {/* Actions Column */}
                                    <div className="col-span-1 lg:col-span-3 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button 
                                                variant="ghost" 
                                                size="sm" 
                                                className={`h-7 px-2 text-[9px] font-bold uppercase tracking-wider rounded-md transition-all ${expandedHistory[item.id] ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'text-indigo-600 hover:bg-indigo-50'}`}
                                                onClick={() => setExpandedHistory(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                                            >
                                                Details
                                            </Button>
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-900" onClick={() => setSelectedConfig({ id: item.id, config: item.config, name: item.name })}>
                                                <Settings2 className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-slate-400 hover:text-slate-900" onClick={() => setSelectedLogs({ id: item.id, logs: item.logs, name: item.name })}>
                                                <MessageSquare className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>

                                {/* Snapshot Drawer */}
                                {expandedHistory[item.id] && (
                                    <div className="bg-slate-50/50 border-t border-slate-100 p-3 lg:px-6 animate-in slide-in-from-top-1 duration-200">
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="h-1 w-3 bg-indigo-500 rounded-full" />
                                            <span className="text-[9px] font-black uppercase text-black tracking-widest">Leg Snapshots</span>
                                            <span className="text-[9px] text-black font-bold ml-auto">Outcome: {item.exitType || 'SQUARED_OFF'}</span>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                            {item.legs?.map((leg, idx) => (
                                                <div key={idx} className="bg-white border border-slate-200/60 rounded-lg p-2.5 flex flex-col gap-2 shadow-sm">
                                                    {/* Header Info */}
                                                    <div className="flex items-center justify-between">
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <span className="text-[11px] font-black text-black truncate">{leg.instrument?.symbol}</span>
                                                            <span className={`text-[8px] font-black px-1 rounded uppercase ${leg.leg?.side === 'BUY' ? 'bg-blue-600 text-white' : 'bg-orange-600 text-white'}`}>
                                                                {leg.leg?.side}
                                                            </span>
                                                            <span className="text-[9px] font-bold text-black bg-slate-50 px-1 border border-slate-100 rounded">
                                                                {leg.leg?.lots * (item.config?.quantity_multiplier || 1)}L
                                                            </span>
                                                        </div>
                                                        <div className="text-right shrink-0">
                                                            <div className={`text-[11px] font-mono font-black leading-none ${(leg.pnlPercent || leg.currentActivePnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                PnL : {(leg.pnlPercent || leg.currentActivePnlPercent || 0) > 0 ? '+' : ''}{(leg.pnlPercent || leg.currentActivePnlPercent || 0).toFixed(2)}% | {(leg.pnlRupees || leg.currentActivePnlRupees || 0) > 0 ? '+' : ''}₹{(leg.pnlRupees || leg.currentActivePnlRupees || 0).toFixed(0)}
                                                            </div>
                                                            <div className="text-[8px] font-black text-black uppercase mt-1">Out Reason : {leg.exitType || 'CLOSED'}</div>
                                                        </div>
                                                    </div>

                                                    {/* Data Grid - Single Line */}
                                                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1.5 py-1.5 border-y border-slate-50">
                                                        <div className="flex justify-between items-center text-[9px]">
                                                            <span className="text-black font-bold">Entry</span>
                                                            <span className="font-mono font-bold text-black ml-2">₹{Number(leg.entryPrice || 0).toFixed(1)}</span>
                                                        </div>
                                                        <div className="flex justify-between items-center text-[9px]">
                                                            <span className="text-black font-bold">Exit</span>
                                                            <span className="font-mono font-bold text-black ml-2">₹{Number(leg.exitSnapshot?.exitLtp || leg.currentLtp || 0).toFixed(1)}</span>
                                                        </div>
                                                        <div className="flex justify-between items-center text-[9px]">
                                                            <span className="text-black font-bold">Init SL</span>
                                                            <span className="font-mono font-bold text-red-500 ml-2">₹{Number(leg.initialSlTriggerPrice || 0).toFixed(1)}</span>
                                                        </div>
                                                        <div className="flex justify-between items-center text-[9px]">
                                                            <span className="text-black font-bold">Final SL</span>
                                                            <span className="font-mono font-bold text-red-600 ml-2">₹{Number(leg.slTriggerPrice || 0).toFixed(1)}</span>
                                                        </div>
                                                    </div>


                                                        {leg.rtp != null && (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">Init RTP</span>
                                                                <span className="font-mono font-bold text-orange-500">₹{Number(leg.rtp).toFixed(1)}</span>
                                                            </div>
                                                        )}
                                                        {leg.re_high_trigger_price != null && (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">RE-High Trig</span>
                                                                <span className="font-mono font-bold text-orange-600">₹{Number(leg.re_high_trigger_price).toFixed(1)}</span>
                                                            </div>
                                                        )}
                                                        {leg.re_low_trigger_price != null && (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">RE-Low Trig</span>
                                                                <span className="font-mono font-bold text-orange-600">₹{Number(leg.re_low_trigger_price).toFixed(1)}</span>
                                                            </div>
                                                        )}
                                                        {(leg.max_peak_price != null && leg.max_peak_price > 0) || leg.final_peak_reached != null ? (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">Tracked High</span>
                                                                <span className="font-mono font-bold text-blue-600">₹{Number(leg.final_peak_reached || leg.max_peak_price || 0).toFixed(1)}</span>
                                                            </div>
                                                        ) : null}
                                                        {(leg.max_low_price != null && leg.max_low_price > 0) || leg.final_low_reached != null ? (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">Tracked Low</span>
                                                                <span className="font-mono font-bold text-red-600">₹{Number(leg.final_low_reached || leg.max_low_price || 0).toFixed(1)}</span>
                                                            </div>
                                                        ) : null}
                                                        {/* Removed Trade Peak/Low display as per user request */}
                                                        {(leg.mntmTargetPrice || leg.mtp) && (
                                                            <div className="flex justify-between items-center text-[9px]">
                                                                <span className="text-black font-bold">Momentum</span>
                                                                <span className="font-mono font-bold text-purple-500">₹{Number(leg.mntmTargetPrice || leg.mtp || 0).toFixed(1)}</span>
                                                            </div>
                                                        )}

                                                        {/* Time Row */}
                                                        <div className="flex items-center justify-between text-[8px] font-mono text-black font-bold mt-1">
                                                            <div className="flex items-center gap-1">
                                                                <Clock className="h-2.5 w-2.5" />
                                                                <span>IN {leg.entryTime}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                <Clock className="h-2.5 w-2.5" />
                                                                <span>OUT {leg.exitTime || leg.exitSnapshot?.exitTime}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Modal Components */}
            {selectedLogs && (
                <StrategyLogs
                    isOpen={!!selectedLogs}
                    onClose={() => setSelectedLogs(null)}
                    logs={selectedLogs.logs}
                    strategyName={selectedLogs.name}
                />
            )}

            {selectedConfig && (
                <StrategyConfigModal
                    isOpen={!!selectedConfig}
                    onClose={() => setSelectedConfig(null)}
                    config={selectedConfig.config}
                    strategyName={selectedConfig.name}
                />
            )}
        </div>
    );
};

