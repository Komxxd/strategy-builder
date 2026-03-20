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
                        <Card key={item.id} className="overflow-hidden border-none shadow-sm hover:shadow-md transition-all group rounded-lg">
                            <CardContent className="p-0">
                                <div className="flex flex-col lg:flex-row">
                                    {/* Left Accent Bar Striped based on status */}
                                    <div className={`w-full lg:w-2 h-2 lg:h-auto ${
                                        item.status === 'COMPLETED' ? 'bg-emerald-500' : 
                                        item.status === 'FAILED' ? 'bg-red-500' : 'bg-slate-300'
                                    }`} />
                                    
                                    <div className="flex-1 p-2.5 flex flex-col md:flex-row items-center justify-between gap-4">
                                        {/* Info Section */}
                                        <div className="flex items-center gap-3 w-full md:w-auto">
                                            <div className={`h-9 w-9 rounded flex items-center justify-center shadow-sm shrink-0 ${
                                                item.config?.is_paper_trading ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'
                                            }`}>
                                                {item.config?.is_paper_trading ? <ShieldCheck className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-slate-900 text-sm leading-tight group-hover:text-primary transition-colors">
                                                    {item.name}
                                                </h3>
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                                    <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                                                        <Activity className="h-2.5 w-2.5" /> {item.config?.index || '---'}
                                                    </span>
                                                    <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                                                        <Clock className="h-2.5 w-2.5" /> {formatDate(item.started_at)}
                                                    </span>
                                                    <span className={`text-[9px] font-black tracking-tighter uppercase px-1 py-0 rounded ${
                                                        item.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' : 
                                                        item.status === 'FAILED' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'
                                                    }`}>
                                                        {item.status}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Performance Section */}
                                        <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end px-2 md:px-0">
                                            <div className="text-right">
                                                <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mb-0.5">Final PnL</p>
                                                <div className={`flex items-center gap-1 font-bold text-sm ${
                                                    item.totalPnlRupees >= 0 ? 'text-emerald-600' : 'text-red-600'
                                                }`}>
                                                    {item.totalPnlRupees >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                                                    ₹{Number(item.totalPnlRupees || 0).toFixed(2)}
                                                    <span className="text-[10px] opacity-70 ml-0.5">({Number(item.pnlPercent || 0).toFixed(2)}%)</span>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-1.5 ml-4">
                                                <Button 
                                                    variant="outline" 
                                                    size="sm" 
                                                    className="h-8 px-3 text-[10px] font-bold gap-1 rounded hover:bg-slate-50 border-slate-200"
                                                    onClick={() => setSelectedConfig({ id: item.id, config: item.config, name: item.name })}
                                                >
                                                    <Settings2 className="h-3.5 w-3.5" />
                                                    <span className="hidden sm:inline">Config</span>
                                                </Button>
                                                <Button 
                                                    variant="secondary" 
                                                    size="sm" 
                                                    className="h-8 px-3 text-[10px] font-bold gap-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
                                                    onClick={() => setSelectedLogs({ id: item.id, logs: item.logs, name: item.name })}
                                                >
                                                    <MessageSquare className="h-3.5 w-3.5" />
                                                    <span className="hidden sm:inline">Logs</span>
                                                </Button>
                                            </div>
                                        </div>
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
