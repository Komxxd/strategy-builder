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
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header Controls */}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                <div className="relative w-full md:w-96">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input 
                        type="text"
                        placeholder="Search by strategy name or ID..."
                        className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-primary/20 transition-all outline-none font-medium"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-xl w-full md:w-auto">
                    {[
                        { id: 'ALL', label: 'All Trades' },
                        { id: 'LIVE', label: 'Live' },
                        { id: 'PAPER', label: 'Paper' }
                    ].map((t) => (
                        <button
                            key={t.id}
                            onClick={() => setFilterType(t.id)}
                            className={`flex-1 md:flex-none px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
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
            <div className="space-y-4">
                {filteredHistory.length === 0 ? (
                    <div className="bg-white rounded-[2rem] border border-dashed border-slate-200 p-20 flex flex-col items-center justify-center text-center">
                        <div className="h-20 w-20 bg-slate-50 rounded-full flex items-center justify-center mb-6">
                            <FilterX className="h-10 w-10 text-slate-300" />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 mb-2">No history found</h3>
                        <p className="text-sm text-slate-500 max-w-xs">Try adjusting your search or filters to find what you are looking for.</p>
                        <Button variant="outline" className="mt-6 rounded-xl font-bold" onClick={() => { setSearchTerm(''); setFilterType('ALL'); }}>
                            Clear All Filters
                        </Button>
                    </div>
                ) : (
                    filteredHistory.map((item) => (
                        <Card key={item.id} className="overflow-hidden border-none shadow-sm hover:shadow-md transition-all group rounded-2xl">
                            <CardContent className="p-0">
                                <div className="flex flex-col lg:flex-row">
                                    {/* Left Accent Bar Striped based on status */}
                                    <div className={`w-full lg:w-2 h-2 lg:h-auto ${
                                        item.status === 'COMPLETED' ? 'bg-emerald-500' : 
                                        item.status === 'FAILED' ? 'bg-red-500' : 'bg-slate-300'
                                    }`} />
                                    
                                    <div className="flex-1 p-5 flex flex-col md:flex-row items-center justify-between gap-6">
                                        {/* Info Section */}
                                        <div className="flex items-start gap-4 w-full md:w-auto">
                                            <div className={`h-12 w-12 rounded-2xl flex items-center justify-center shadow-sm shrink-0 ${
                                                item.config?.is_paper_trading ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'
                                            }`}>
                                                {item.config?.is_paper_trading ? <ShieldCheck className="h-6 w-6" /> : <Zap className="h-6 w-6" />}
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-slate-900 text-lg leading-tight group-hover:text-primary transition-colors">
                                                    {item.name}
                                                </h3>
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                                                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                                                        <Activity className="h-3 w-3" /> {item.config?.index || '---'}
                                                    </span>
                                                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-1">
                                                        <Calendar className="h-3 w-3" /> {formatDate(item.started_at)}
                                                    </span>
                                                    <span className={`text-[10px] font-black tracking-tighter uppercase px-1.5 py-0.5 rounded ${
                                                        item.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700' : 
                                                        item.status === 'FAILED' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'
                                                    }`}>
                                                        {item.status}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Performance Section */}
                                        <div className="flex items-center gap-8 w-full md:w-auto justify-between md:justify-end px-4 md:px-0">
                                            <div className="text-right">
                                                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Final PnL</p>
                                                <div className={`flex items-center gap-1.5 font-black text-lg ${
                                                    item.totalPnlRupees >= 0 ? 'text-emerald-600' : 'text-red-600'
                                                }`}>
                                                    {item.totalPnlRupees >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                                                    ₹{Number(item.totalPnlRupees || 0).toFixed(2)}
                                                    <span className="text-xs opacity-70 ml-0.5">({Number(item.pnlPercent || 0).toFixed(2)}%)</span>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <Button 
                                                    variant="outline" 
                                                    size="sm" 
                                                    className="rounded-xl h-10 px-4 font-bold gap-2 hover:bg-slate-50 border-slate-200"
                                                    onClick={() => setSelectedConfig({ id: item.id, config: item.config, name: item.name })}
                                                >
                                                    <Settings2 className="h-4 w-4" />
                                                    <span className="hidden sm:inline">Config</span>
                                                </Button>
                                                <Button 
                                                    variant="secondary" 
                                                    size="sm" 
                                                    className="rounded-xl h-10 px-4 font-bold gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700"
                                                    onClick={() => setSelectedLogs({ id: item.id, logs: item.logs, name: item.name })}
                                                >
                                                    <MessageSquare className="h-4 w-4" />
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
