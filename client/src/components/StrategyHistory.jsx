import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { History, ShieldCheck, Zap } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001/api';

export const StrategyHistory = ({ userId }) => {
    const [history, setHistory] = useState([]);
    const [activeTab, setActiveTab] = useState('paper');

    const fetchHistory = async () => {
        if (!userId) return;
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/history/${userId}`);
            if (res.data?.success) {
                setHistory(res.data.data);
            }
        } catch (err) {
            console.error("Error fetching execution history:", err);
        }
    };

    useEffect(() => {
        fetchHistory();
        // Poll less frequently for history, e.g., every 10 seconds
        const interval = setInterval(fetchHistory, 10000);
        return () => clearInterval(interval);
    }, [userId]);

    const filteredHistory = history.filter(s => (activeTab === 'paper' ? s.config?.is_paper_trading : !s.config?.is_paper_trading));

    return (
        <div className="space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-8 h-12 bg-muted/50 p-1 rounded-2xl">
                    <TabsTrigger value="paper" className="rounded-xl font-bold data-[state=active]:bg-blue-600 data-[state=active]:text-white flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" /> Paper Trading History
                    </TabsTrigger>
                    <TabsTrigger value="live" className="rounded-xl font-bold data-[state=active]:bg-orange-600 data-[state=active]:text-white flex items-center gap-2">
                        <Zap className="h-4 w-4" /> Live Market History
                    </TabsTrigger>
                </TabsList>
            </Tabs>

            <Card className="w-full border-border bg-card">
                <CardHeader className="border-b py-4 bg-muted/30">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                        <History className="h-4 w-4 text-primary" /> Execution History
                    </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-muted text-muted-foreground">
                                <tr>
                                    <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Date & Time</th>
                                    <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Strategy Name</th>
                                    <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Index</th>
                                    <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Status</th>
                                    <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Exit Reason</th>
                                    <th className="px-4 py-3 text-right font-bold text-xs uppercase tracking-wider">Result (PnL)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y border-t">
                                {filteredHistory.length === 0 ? (
                                    <tr>
                                        <td colSpan="6" className="px-4 py-8 text-center text-muted-foreground">
                                            No execution history found for {activeTab} trading.
                                        </td>
                                    </tr>
                                ) : (
                                    filteredHistory.map((s) => (
                                        <tr key={s.id} className="hover:bg-muted/50 transition-colors">
                                            <td className="px-4 py-4 font-mono text-xs text-muted-foreground whitespace-nowrap">
                                                <div className="flex flex-col">
                                                    <span>{new Date(s.started_at).toLocaleDateString()}</span>
                                                    <span>{new Date(s.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 font-bold text-base">
                                                {s.name || s.config?.name || 'Unnamed Strategy'}
                                                <div className="text-[10px] font-mono text-muted-foreground font-normal mt-1">ID: {s.id.split('-')[0]}</div>
                                            </td>
                                            <td className="px-4 py-4 font-bold">{s.config?.index}</td>
                                            <td className="px-4 py-4 text-xs font-bold uppercase">
                                                <span className={`px-2 py-1 rounded-md ${s.status === 'COMPLETED' ? 'bg-blue-100 text-blue-700' :
                                                    s.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-700'
                                                    }`}>
                                                    {s.status}
                                                </span>
                                            </td>
                                            <td className="px-4 py-4 text-xs font-medium text-muted-foreground cursor-pointer" title={s.exitType || s.error}>
                                                {s.exitType ? s.exitType.replace('_', ' ') : (s.error ? "ERROR" : "---")}
                                            </td>
                                            <td className="px-4 py-4 text-right">
                                                <div className="flex flex-col items-end">
                                                    <span className={`font-mono text-base font-bold ${(s.pnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                        {(s.pnlPercent || 0) > 0 ? '+' : ''}{Number(s.pnlPercent || 0).toFixed(2)}%
                                                    </span>
                                                    <span className={`text-xs font-mono font-bold ${(s.totalPnlRupees || 0) >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                                                        {(s.totalPnlRupees || 0) > 0 ? '+' : ''}₹{Number(s.totalPnlRupees || 0).toFixed(2)}
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};
