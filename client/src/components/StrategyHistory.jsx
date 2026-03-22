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
    const [expandedId, setExpandedId] = useState(null);

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

            {/* History Table/List */}
            <div className="space-y-2">
                {filteredHistory.length === 0 ? (
                    <div className="bg-white rounded-lg border border-dashed border-slate-200 p-12 flex flex-col items-center justify-center text-center">
                        <div className="h-12 w-12 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                            <FilterX className="h-6 w-6 text-slate-300" />
                        </div>
                        <h3 className="text-base font-bold text-slate-900 mb-1">No history found</h3>
                        <p className="text-xs text-slate-500 max-w-xs transition-opacity opacity-70">Try adjusting your search or filters.</p>
                        <Button variant="outline" size="sm" className="mt-4 rounded-md font-bold text-xs" onClick={() => { setSearchTerm(''); setFilterType('ALL'); }}>
                            Clear All Filters
                        </Button>
                    </div>
                ) : (
                    filteredHistory.map((item) => (
                        <Card key={item.id} className="overflow-hidden border border-slate-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 group rounded-2xl bg-white">
                            <CardContent className="p-0">
                                <div className="flex flex-col lg:flex-row">
                                    {/* Left Accent Bar Striped based on status */}
                                    <div className={`w-full lg:w-1.5 h-1.5 lg:h-auto shrink-0 ${
                                        item.status === 'COMPLETED' ? 'bg-emerald-500' : 
                                        item.status === 'FAILED' ? 'bg-red-500' : 'bg-slate-300'
                                    }`} />
                                    
                                    <div className="flex-1 flex flex-col min-w-0">
                                        <div className="p-3.5 flex flex-col md:flex-row items-center justify-between gap-4">
                                            {/* Info Section */}
                                        <div className="flex items-center gap-4 w-full md:w-auto">
                                            <div className={`h-11 w-11 rounded-xl flex items-center justify-center shadow-sm shrink-0 transition-transform group-hover:scale-105 ${
                                                item.config?.is_paper_trading ? 'bg-blue-50 text-blue-600 border border-blue-100' : 'bg-orange-50 text-orange-600 border border-orange-100'
                                            }`}>
                                                {item.config?.is_paper_trading ? <ShieldCheck className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
                                            </div>
                                            <div>
                                                <h3 className="font-black text-slate-800 text-[15px] leading-tight group-hover:text-indigo-600 transition-colors">
                                                    {item.name}
                                                </h3>
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                                                        <Activity className="h-3 w-3 text-slate-300" /> {item.config?.index || '---'}
                                                    </span>
                                                    <div className="h-1 w-1 bg-slate-200 rounded-full" />
                                                    <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1">
                                                        <Clock className="h-3 w-3 text-slate-300" /> {formatDate(item.started_at)}
                                                    </span>
                                                    <span className={`text-[9px] font-black tracking-tight uppercase px-2 py-0.5 rounded-full border ${
                                                        item.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 
                                                        item.status === 'FAILED' ? 'bg-red-50 text-red-700 border-red-100' : 'bg-slate-50 text-slate-600 border-slate-200'
                                                    }`}>
                                                        {item.status}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        {/* Performance Section */}
                                        <div className="flex items-center gap-6 w-full md:w-auto justify-between md:justify-end">
                                            <div className="text-right">
                                                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Final Performance</p>
                                                <div className={`flex items-center gap-1 font-black text-lg tracking-tighter ${
                                                    item.totalPnlRupees >= 0 ? 'text-emerald-600' : 'text-red-600'
                                                }`}>
                                                    ₹{Number(item.totalPnlRupees || 0).toFixed(0)}
                                                    <span className={`text-xs ml-0.5 font-bold ${item.totalPnlRupees >= 0 ? 'text-emerald-500/80' : 'text-red-500/80'}`}>
                                                        ({Number(item.pnlPercent || 0).toFixed(2)}%)
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <Button 
                                                    variant="outline" 
                                                    size="sm" 
                                                    className={`h-9 px-4 text-[11px] font-black uppercase tracking-wider gap-2 rounded-xl border-slate-200 shadow-sm transition-all ${expandedId === item.id ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'hover:bg-slate-50 hover:border-indigo-200 hover:text-indigo-600'}`}
                                                    onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                                                >
                                                    <Activity className="h-3.5 w-3.5" />
                                                    Snapshot
                                                </Button>
                                                <div className="w-px h-6 bg-slate-100 mx-1" />
                                                <Button 
                                                    variant="ghost" 
                                                    size="sm" 
                                                    className="h-9 w-9 p-0 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 border border-transparent hover:border-indigo-100 transition-all"
                                                    onClick={() => setSelectedConfig({ id: item.id, config: item.config, name: item.name })}
                                                    title="View Config"
                                                >
                                                    <Settings2 className="h-4 w-4" />
                                                </Button>
                                                <Button 
                                                    variant="ghost" 
                                                    size="sm" 
                                                    className="h-9 w-9 p-0 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 border border-transparent hover:border-indigo-100 transition-all"
                                                    onClick={() => setSelectedLogs({ id: item.id, logs: item.logs, name: item.name })}
                                                    title="View Logs"
                                                >
                                                    <MessageSquare className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    {/* Expanded Snapshot View */}
                                    {expandedId === item.id && (
                                        <div className="border-t border-slate-100 bg-slate-50/80 p-5 animate-in slide-in-from-top-2 duration-300">
                                            <div className="flex items-center justify-between px-1 mb-4">
                                                <div className="flex items-center gap-2.5">
                                                    <div className="h-5 w-1.5 bg-indigo-500 rounded-full shadow-sm shadow-indigo-200" />
                                                    <h4 className="text-[12px] font-black uppercase text-slate-600 tracking-widest">Execution Blueprint</h4>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-xl shadow-sm">
                                                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-tight">Exit Reason</span>
                                                        <span className="text-[11px] font-black text-slate-700">{item.exitType || 'SQUARED_OFF'}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            <div className="space-y-1.5">
                                                {item.legs && item.legs.length > 0 ? (
                                                    item.legs.map((leg, idx) => (
                                                        <div key={`${item.id}-leg-${idx}`} className="flex items-center justify-between p-3 bg-white hover:bg-slate-50 border border-slate-200/60 rounded-xl transition-all shadow-sm">
                                                            <div className="flex flex-col gap-1.5 flex-1">
                                                                <div className="flex items-center gap-2 flex-wrap">
                                                                    <span className="text-sm font-black text-slate-800 tracking-tight">{leg.instrument?.symbol || "---"}</span>
                                                                    <div className="flex items-center gap-1">
                                                                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${leg.leg?.side === 'BUY' ? 'bg-blue-600 text-white' : 'bg-orange-600 text-white'}`}>
                                                                            {leg.leg?.side}
                                                                        </span>
                                                                        <span className="px-2 py-0.5 bg-slate-100 text-[9px] font-bold text-slate-500 rounded border border-slate-200">
                                                                            {leg.leg?.lots} L
                                                                        </span>
                                                                    </div>
                                                                    {leg.instrument?.strike && (
                                                                        <span className="px-2 py-0.5 bg-indigo-50 text-[9px] font-black text-indigo-600 rounded border border-indigo-100">
                                                                            STRIKE {parseFloat(leg.instrument.strike) / 100 || leg.instrument.strike}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                
                                                                <div className="flex items-center gap-3 text-[10px] font-mono whitespace-nowrap overflow-x-auto no-scrollbar">
                                                                    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-50 text-slate-400 border border-slate-100">
                                                                        <Clock className="h-2.5 w-2.5" />
                                                                        <span>{leg.entryTime || "---"}</span>
                                                                    </div>
                                                                    
                                                                    <div className="flex items-center gap-1 text-slate-500">
                                                                        <span className="text-slate-400 uppercase text-[9px] font-bold">Entry</span>
                                                                        <span className="font-bold">₹{Number(leg.entryPrice || 0).toFixed(2)}</span>
                                                                    </div>

                                                                    <div className="flex items-center gap-1 text-slate-900">
                                                                        <span className="text-slate-400 uppercase text-[9px] font-bold">Exit</span>
                                                                        <span className="font-bold">₹{Number(leg.currentLtp || 0).toFixed(2)}</span>
                                                                    </div>
                                                                    
                                                                    <div className="flex gap-1.5 flex-wrap">
                                                                        {leg.initialSlTriggerPrice != null && (
                                                                            <span className="text-slate-400 font-bold px-1.5 py-0.5 bg-slate-50 border border-slate-100 rounded text-[9px] uppercase tracking-tighter shrink-0">Init SL: {Number(leg.initialSlTriggerPrice).toFixed(1)}</span>
                                                                        )}
                                                                        {leg.slTriggerPrice != null && (
                                                                            <span className={`font-bold px-1.5 py-0.5 border rounded text-[9px] uppercase tracking-tighter shrink-0 ${Number(leg.slTriggerPrice) !== Number(leg.initialSlTriggerPrice) ? 'text-indigo-600 bg-indigo-50 border-indigo-100' : 'text-red-600 bg-red-50/50 border-red-100/50'}`}>
                                                                                Now SL: {Number(leg.slTriggerPrice).toFixed(1)}
                                                                            </span>
                                                                        )}
                                                                        {leg.rtp != null && (
                                                                            <span className="text-orange-600 font-bold px-1.5 py-0.5 bg-orange-50/50 border border-orange-100/50 rounded">RTP {Number(leg.rtp).toFixed(2)}</span>
                                                                        )}
                                                                        {leg.mtp != null && (
                                                                            <span className="text-purple-600 font-bold px-1.5 py-0.5 bg-purple-50/50 border border-purple-100/50 rounded">MTP {Number(leg.mtp).toFixed(2)}</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            
                                                            <div className="flex flex-col items-end pl-4 ml-4 border-l border-slate-100 min-w-[70px]">
                                                                <div className={`text-base font-mono font-black tracking-tighter ${Number(leg.currentActivePnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                    {Number(leg.currentActivePnlPercent || 0) > 0 ? '+' : ''}{Number(leg.currentActivePnlPercent || 0).toFixed(2)}%
                                                                </div>
                                                                <div className={`text-[10px] font-mono font-bold leading-none ${Number(leg.currentActivePnlRupees || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                                                    {Number(leg.currentActivePnlRupees || 0) > 0 ? '+' : ''}₹{Number(leg.currentActivePnlRupees || 0).toFixed(1)}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div className="text-center py-4 bg-white border border-dashed border-slate-200 rounded-lg">
                                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">No Leg Snapshot Available</p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                    ))
                )}
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
