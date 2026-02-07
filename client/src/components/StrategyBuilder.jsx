import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StopCircle, Loader2, TrendingUp, Timer, LayoutDashboard, Target, Save, Play, Plus, Trash2 } from 'lucide-react';
import axios from 'axios';

const API_BASE_URL = "http://localhost:5001/api";

export const StrategyBuilder = ({ userId }) => {
    const [loading, setLoading] = useState(false);
    const [strategyId, setStrategyId] = useState(null);
    const [status, setStatus] = useState(null);
    const [strategyData, setStrategyData] = useState(null);
    const [history, setHistory] = useState([]);
    const [editingId, setEditingId] = useState(null);

    const [config, setConfig] = useState({
        index: 'NIFTY',
        stop_loss: 10,
        sl_limit_margin: 0,
        entry_time: '09:20',
        exit_time: '15:15',
        variety: 'NORMAL',
        ordertype: 'MARKET',
        producttype: 'INTRADAY',
        duration: 'DAY',
        price: '0',
        triggerprice: '0',
        squareoff: '0',
        stoploss: '0',
        legs: [
            { option_type: 'CE', strike: 'OTM1', side: 'BUY', lots: 1 }
        ]
    });

    const fetchHistory = async () => {
        if (!userId) return;
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/user/${userId}`);
            setHistory(res.data?.data || []);
        } catch (err) {
            console.error("Error fetching history:", err);
        }
    };

    const fetchActive = async () => {
        if (!userId) return;
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/active/${userId}`);
            if (res.data?.data) {
                setStrategyId(res.data.data.id);
                setStatus(res.data.data.status);
                setStrategyData(res.data.data);
            }
        } catch (err) {
            console.error("Error fetching active strategy:", err);
        }
    };

    React.useEffect(() => {
        fetchHistory();
        fetchActive();
    }, [userId]);

    const handleSave = async () => {
        setLoading(true);
        try {
            if (editingId) {
                await axios.put(`${API_BASE_URL}/strategy/update/${editingId}`, { ...config, userId });
                setEditingId(null);
            } else {
                await axios.post(`${API_BASE_URL}/strategy/save`, { ...config, userId });
            }
            fetchHistory();
        } catch (err) {
            alert("Error saving strategy: " + err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleExecute = async (id) => {
        try {
            const res = await axios.post(`${API_BASE_URL}/strategy/execute/${id}`);
            setStrategyId(res.data.strategy_id);
            setStatus("Running (Waiting for Entry)");
            fetchHistory();
        } catch (err) {
            alert("Error executing strategy: " + err.message);
        }
    };

    const handleStop = async () => {
        if (!strategyId) return;
        try {
            await axios.post(`${API_BASE_URL}/strategy/stop/${strategyId}`);
            setStrategyId(null);
            setStatus(null);
            setStrategyData(null);
            fetchHistory();
        } catch (err) {
            alert("Error stopping strategy: " + err.message);
        }
    };

    const handleEdit = (strategy) => {
        setConfig(strategy.config);
        setEditingId(strategy.id);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleDelete = async (strategyIdToDelete) => {
        if (!confirm("Delete this strategy?")) return;
        try {
            await axios.delete(`${API_BASE_URL}/strategy/delete/${strategyIdToDelete}`);
            fetchHistory();
        } catch (err) {
            alert("Error deleting strategy: " + err.message);
        }
    };

    React.useEffect(() => {
        let interval;
        if (strategyId && status !== "COMPLETED" && status !== "FAILED") {
            interval = setInterval(async () => {
                try {
                    const res = await axios.get(`${API_BASE_URL}/strategy/status/${strategyId}`);
                    setStatus(res.data.data.status);
                    setStrategyData(res.data.data);
                    if (res.data.data.status === "COMPLETED" || res.data.data.status === "FAILED") {
                        clearInterval(interval);
                    }
                } catch (err) {
                    console.error("Error polling status:", err);
                }
            }, 3000);
        }
        return () => clearInterval(interval);
    }, [strategyId, status]);

    return (
        <div className="space-y-6">
            <Card className="w-full border-border bg-card overflow-hidden">
                <CardHeader className="border-b bg-muted">
                    <CardTitle className="flex items-center gap-2 text-xl font-bold">
                        <Target className="h-5 w-5 text-primary" />
                        Strategy Configuration
                    </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                <LayoutDashboard className="h-3 w-3" /> Index
                            </Label>
                            <Select value={config.index} onValueChange={(v) => setConfig({ ...config, index: v })}>
                                <SelectTrigger className="h-11 rounded-xl">
                                    <SelectValue placeholder="Select Index" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="NIFTY">NIFTY</SelectItem>
                                    <SelectItem value="BANKNIFTY">BANKNIFTY</SelectItem>
                                    <SelectItem value="FINNIFTY">FINNIFTY</SelectItem>
                                    <SelectItem value="SENSEX">SENSEX (BSE)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Stop Loss (%)</Label>
                            <Input
                                className="h-11 rounded-xl"
                                type="number"
                                value={config.stop_loss}
                                onChange={(e) => setConfig({ ...config, stop_loss: parseFloat(e.target.value) })}
                            />
                            <p className="text-[10px] text-muted-foreground italic">Calculated from entry price</p>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">SL Limit Margin (Points)</Label>
                            <Input
                                className="h-11 rounded-xl"
                                type="number"
                                value={config.sl_limit_margin}
                                onChange={(e) => setConfig({ ...config, sl_limit_margin: parseFloat(e.target.value) })}
                            />
                            <p className="text-[10px] text-muted-foreground italic">Added to trigger price for SL-L</p>
                        </div>

                    </div>

                    <div className="flex items-center justify-between pt-6">
                        <div className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                            Strategy Legs
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            className="h-9 gap-2 rounded-xl"
                            onClick={() => {
                                const next = [...config.legs, { option_type: 'CE', strike: 'ATM', side: 'BUY', lots: 1 }];
                                setConfig({ ...config, legs: next });
                            }}
                        >
                            <Plus className="h-4 w-4" /> Add Leg
                        </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
                        {config.legs.map((leg, legIndex) => {
                            return (
                                <div key={`leg-${legIndex}`} className="border rounded-2xl p-4 bg-muted/30">
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                            Leg {legIndex + 1}
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            className="h-8 px-2 text-destructive"
                                            onClick={() => {
                                                if (config.legs.length === 1) return;
                                                const next = config.legs.filter((_, i) => i !== legIndex);
                                                setConfig({ ...config, legs: next });
                                            }}
                                            disabled={config.legs.length === 1}
                                            title={config.legs.length === 1 ? "At least one leg is required" : "Remove leg"}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                                <TrendingUp className="h-3 w-3" /> Option Type
                                            </Label>
                                            <Select
                                                value={leg.option_type}
                                                onValueChange={(v) => {
                                                    const next = [...config.legs];
                                                    next[legIndex] = { ...next[legIndex], option_type: v };
                                                    setConfig({ ...config, legs: next });
                                                }}
                                            >
                                                <SelectTrigger className="h-11 rounded-xl">
                                                    <SelectValue placeholder="Type" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="CE">CE (Call)</SelectItem>
                                                    <SelectItem value="PE">PE (Put)</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                                <Target className="h-3 w-3" /> Strike
                                            </Label>
                                            <Select
                                                value={leg.strike}
                                                onValueChange={(v) => {
                                                    const next = [...config.legs];
                                                    next[legIndex] = { ...next[legIndex], strike: v };
                                                    setConfig({ ...config, legs: next });
                                                }}
                                            >
                                                <SelectTrigger className="h-11 rounded-xl">
                                                    <SelectValue placeholder="Select Strike" />
                                                </SelectTrigger>
                                                <SelectContent className="max-h-[300px]">
                                                    <SelectItem value="ATM">ATM (At the Money)</SelectItem>
                                                    {Array.from({ length: 30 }, (_, i) => i + 1).map(n => (
                                                        <SelectItem key={`otm${legIndex}-${n}`} value={`OTM${n}`}>OTM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                                    ))}
                                                    {Array.from({ length: 30 }, (_, i) => i + 1).map(n => (
                                                        <SelectItem key={`itm${legIndex}-${n}`} value={`ITM${n}`}>ITM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Side</Label>
                                            <Select
                                                value={leg.side}
                                                onValueChange={(v) => {
                                                    const next = [...config.legs];
                                                    next[legIndex] = { ...next[legIndex], side: v };
                                                    setConfig({ ...config, legs: next });
                                                }}
                                            >
                                                <SelectTrigger className="h-11 rounded-xl">
                                                    <SelectValue placeholder="Side" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="BUY">BUY</SelectItem>
                                                    <SelectItem value="SELL">SELL</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Lots</Label>
                                            <Input
                                                className="h-11 rounded-xl"
                                                type="number"
                                                value={leg.lots}
                                                onChange={(e) => {
                                                    const next = [...config.legs];
                                                    next[legIndex] = { ...next[legIndex], lots: parseInt(e.target.value) };
                                                    setConfig({ ...config, legs: next });
                                                }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-6">

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Variety</Label>
                            <Select value={config.variety} onValueChange={(v) => setConfig({ ...config, variety: v })}>
                                <SelectTrigger className="h-11 rounded-xl">
                                    <SelectValue placeholder="Variety" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="NORMAL">NORMAL</SelectItem>
                                    <SelectItem value="STOPLOSS">STOPLOSS</SelectItem>
                                    <SelectItem value="ROBO">ROBO</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Product Type</Label>
                            <Select value={config.producttype} onValueChange={(v) => setConfig({ ...config, producttype: v })}>
                                <SelectTrigger className="h-11 rounded-xl">
                                    <SelectValue placeholder="Product" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="CARRYFORWARD">CARRYFORWARD (NRML)</SelectItem>
                                    <SelectItem value="INTRADAY">INTRADAY (MIS)</SelectItem>
                                    <SelectItem value="DELIVERY">DELIVERY (CNC)</SelectItem>
                                    <SelectItem value="MARGIN">MARGIN</SelectItem>
                                    <SelectItem value="BO">BO (Bracket Order)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Order Type</Label>
                            <Select value={config.ordertype} onValueChange={(v) => setConfig({ ...config, ordertype: v })}>
                                <SelectTrigger className="h-11 rounded-xl">
                                    <SelectValue placeholder="Order Type" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="MARKET">MARKET</SelectItem>
                                    <SelectItem value="LIMIT">LIMIT</SelectItem>
                                    <SelectItem value="STOPLOSS_LIMIT">SL-L</SelectItem>
                                    <SelectItem value="STOPLOSS_MARKET">SL-M</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Duration</Label>
                            <Select value={config.duration} onValueChange={(v) => setConfig({ ...config, duration: v })}>
                                <SelectTrigger className="h-11 rounded-xl">
                                    <SelectValue placeholder="Duration" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="DAY">DAY</SelectItem>
                                    <SelectItem value="IOC">IOC</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                <Timer className="h-3 w-3" /> Entry Time
                            </Label>
                            <Input
                                className="h-11 rounded-xl"
                                type="time"
                                value={config.entry_time}
                                onChange={(e) => setConfig({ ...config, entry_time: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                <Timer className="h-3 w-3" /> Exit Time
                            </Label>
                            <Input
                                className="h-11 rounded-xl"
                                type="time"
                                value={config.exit_time}
                                onChange={(e) => setConfig({ ...config, exit_time: e.target.value })}
                            />
                        </div>

                        {config.ordertype !== 'MARKET' && (
                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price</Label>
                                <Input
                                    className="h-11 rounded-xl"
                                    type="number"
                                    value={config.price}
                                    onChange={(e) => setConfig({ ...config, price: e.target.value })}
                                />
                            </div>
                        )}

                        {(config.ordertype === 'STOPLOSS_LIMIT' || config.ordertype === 'STOPLOSS_MARKET') && (
                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Trigger Price</Label>
                                <Input
                                    className="h-11 rounded-xl"
                                    type="number"
                                    value={config.triggerprice}
                                    onChange={(e) => setConfig({ ...config, triggerprice: e.target.value })}
                                />
                            </div>
                        )}

                        <div className="flex items-end">
                            <Button
                                className="w-full h-11 gap-2 rounded-xl shadow-lg font-bold"
                                onClick={handleSave}
                                disabled={loading}
                            >
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                {editingId ? "Update Strategy" : "Save Strategy"}
                            </Button>
                        </div>
                        {editingId && (
                            <div className="flex items-end">
                                <Button
                                    variant="outline"
                                    className="w-full h-11 gap-2 rounded-xl"
                                    onClick={() => setEditingId(null)}
                                >
                                    Cancel Edit
                                </Button>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            {strategyId && (
                <Card className="w-full border-border bg-muted animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <CardContent className="p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="space-y-1">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-muted rounded-lg">
                                        <Timer className="h-4 w-4 text-primary" />
                                    </div>
                                    <p className="text-sm font-bold">Strategy Monitor <span className="text-xs font-mono text-muted-foreground ml-2">#{strategyId}</span></p>
                                </div>
                                <div className="flex items-center gap-2 mt-2">
                                    <span className="relative flex h-2 w-2">
                                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status === 'FAILED' ? 'bg-red-400' : 'bg-green-400'} opacity-75`}></span>
                                        <span className={`relative inline-flex rounded-full h-2 w-2 ${status === 'FAILED' ? 'bg-red-500' : 'bg-green-500'}`}></span>
                                    </span>
                                    <span className="text-sm font-bold uppercase tracking-tight">{status}</span>
                                </div>
                            </div>
                            <Button variant="outline" className="rounded-xl border-destructive hover:bg-red-50 text-destructive" onClick={handleStop}>
                                <StopCircle className="h-4 w-4 mr-2" /> Terminate
                            </Button>
                        </div>

                        {strategyData?.status === "IN_POSITION" || strategyData?.status === "COMPLETED" ? (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-border">
                                <div className="p-3 bg-muted rounded-xl">
                                    <span className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Entry Price</span>
                                    <span className="text-sm font-mono font-bold">
                                        {strategyData.legs?.map((l) => l.entryPrice ? l.entryPrice.toFixed(2) : '---').join(' / ') || '---'}
                                    </span>
                                </div>
                                <div className="p-3 bg-muted rounded-xl">
                                    <span className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Live LTP</span>
                                    <span className="text-sm font-mono font-bold animate-pulse">
                                        {strategyData.legs?.map((l) => l.currentLtp ? l.currentLtp.toFixed(2) : '---').join(' / ') || '---'}
                                    </span>
                                </div>
                                <div className={`p-3 rounded-xl ${(strategyData.pnlPercent || 0) >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                                    <span className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Return (%)</span>
                                    <span className={`text-lg font-mono font-bold ${(strategyData.pnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                        {(strategyData.pnlPercent || 0) > 0 ? '+' : ''}{(strategyData.pnlPercent || 0).toFixed(2)}%
                                    </span>
                                </div>
                                <div className="p-3 bg-muted rounded-xl">
                                    <span className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Instrument</span>
                                    <span className="text-sm font-bold">
                                        {strategyData.legs?.map((l) => l.instrument?.symbol || '---').join(' / ') || '---'}
                                    </span>
                                </div>
                            </div>
                        ) : null}
                    </CardContent>
                </Card>
            )}
            {history.length > 0 && (
                <Card className="w-full border-border bg-card">
                    <CardHeader className="border-b py-4">
                        <CardTitle className="text-lg font-bold flex items-center gap-2">
                            <Timer className="h-4 w-4 text-primary" /> Strategy History
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted text-muted-foreground">
                                    <tr>
                                        <th className="px-4 py-2 text-left font-bold">DATE</th>
                                        <th className="px-4 py-2 text-left font-bold">INDEX</th>
                                        <th className="px-4 py-2 text-left font-bold">TYPE</th>
                                        <th className="px-4 py-2 text-left font-bold">STATUS</th>
                                        <th className="px-4 py-2 text-left font-bold">RESULT</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y border-t">
                                    {history.map((s) => (
                                        <tr key={s.id} className="hover:bg-muted/50 transition-colors">
                                            <td className="px-4 py-3 font-mono text-xs">
                                                {new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </td>
                                            <td className="px-4 py-3 font-bold">{s.config.index}</td>
                                            <td className="px-4 py-3">
                                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                                                    {s.config.legs?.map((l) => `${l.side} ${l.option_type}`).join(' | ') || '---'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${s.status === 'COMPLETED' ? 'bg-blue-100 text-blue-700' :
                                                    s.status === 'FAILED' ? 'bg-red-100 text-red-700' :
                                                        s.status === 'SAVED' ? 'bg-slate-100 text-slate-700' : 'bg-yellow-100 text-yellow-700'
                                                    }`}>
                                                    {s.status}
                                                </span>
                                            </td>
                                    <td className="px-4 py-3 font-mono font-bold">
                                        {s.status === 'SAVED' ? (
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    className="h-7 px-3 gap-1 rounded-lg text-[10px]"
                                                    onClick={() => handleExecute(s.id)}
                                                >
                                                    <Play className="h-3 w-3" /> Execute
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 px-3 gap-1 rounded-lg text-[10px]"
                                                    onClick={() => handleEdit(s)}
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    className="h-7 px-3 gap-1 rounded-lg text-[10px]"
                                                    onClick={() => handleDelete(s.id)}
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        ) : (
                                            (s.final_pnl_percent !== null && s.final_pnl_percent !== undefined) ? (
                                                <span className={s.final_pnl_percent >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                                    {s.final_pnl_percent > 0 ? '+' : ''}{Number(s.final_pnl_percent).toFixed(2)}%
                                                        </span>
                                                    ) : '---'
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
};
