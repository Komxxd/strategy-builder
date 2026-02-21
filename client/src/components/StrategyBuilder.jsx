import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StopCircle, Loader2, TrendingUp, Timer, LayoutDashboard, Target, Save, Play, Plus, Trash2, ShieldCheck, Zap } from 'lucide-react';
import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";

export const StrategyBuilder = ({ userId }) => {
    const [loading, setLoading] = useState(false);
    const [runningStrategies, setRunningStrategies] = useState({}); // { id: data }
    const [history, setHistory] = useState([]);
    const [editingId, setEditingId] = useState(null);
    const [activeTab, setActiveTab] = useState('paper');

    const [config, setConfig] = useState({
        name: '',
        index: 'NIFTY',
        entry_time: '09:20:00',
        exit_time: '15:15:00',
        variety: 'NORMAL',
        ordertype: 'MARKET',
        producttype: 'INTRADAY',
        duration: 'DAY',
        price: '0',
        triggerprice: '0',
        squareoff: '0',
        stoploss: '0',
        overall_sl_type: 'PERCENTAGE',
        overall_sl_value: 0,
        entry_limit_offset: 0,
        legs: [
            { strike_criteria: 'STRIKE_TYPE', option_type: 'CE', strike: 'ATM', premium: 0, side: 'BUY', lots: 1, sl_type: 'PERCENTAGE', stop_loss: 10 }
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
            if (res.data?.data && Array.isArray(res.data.data)) {
                const activeMap = {};
                res.data.data.forEach(s => {
                    activeMap[s.id] = s;
                });
                setRunningStrategies(activeMap);
            }
        } catch (err) {
            console.error("Error fetching active strategies:", err);
        }
    };

    React.useEffect(() => {
        fetchHistory();
        fetchActive();
    }, [userId]);

    const handleSave = async () => {
        setLoading(true);
        const finalConfig = { ...config, is_paper_trading: activeTab === 'paper', userId };
        try {
            if (editingId) {
                await axios.put(`${API_BASE_URL}/strategy/update/${editingId}`, finalConfig);
                setEditingId(null);
            } else {
                await axios.post(`${API_BASE_URL}/strategy/save`, finalConfig);
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
            const newId = res.data.strategy_id || res.data.execution_id;
            // Fetch initial status
            const statusRes = await axios.get(`${API_BASE_URL}/strategy/status/${newId}`);
            setRunningStrategies(prev => ({
                ...prev,
                [newId]: statusRes.data.data
            }));
            fetchActive();
            // We no longer call fetchHistory() here because execution doesn't create a new template
        } catch (err) {
            alert("Error executing strategy: " + err.message);
        }
    };

    const handleStop = async (id) => {
        if (!id) return;
        try {
            await axios.post(`${API_BASE_URL}/strategy/stop/${id}`);
            fetchActive();
        } catch (err) {
            alert("Error stopping strategy: " + err.message);
        }
    };

    const handleSquareOff = async (id) => {
        if (!id) return;
        if (!confirm("Are you sure you want to instantly square off all positions for this strategy?")) return;
        try {
            await axios.post(`${API_BASE_URL}/strategy/squareoff/${id}`);
            fetchActive();
        } catch (err) {
            alert("Error squaring off strategy: " + err.response?.data?.message || err.message);
        }
    };

    const handleEdit = (strategy) => {
        setConfig(strategy.config);
        setEditingId(strategy.id);
        setActiveTab(strategy.config.is_paper_trading ? 'paper' : 'live');
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
        const activeIds = Object.keys(runningStrategies);

        if (activeIds.length > 0) {
            interval = setInterval(async () => {
                try {
                    const latestActiveIds = Object.keys(runningStrategies);
                    const updates = await Promise.all(
                        latestActiveIds.map(async (id) => {
                            try {
                                const res = await axios.get(`${API_BASE_URL}/strategy/status/${id}`);
                                return { id, data: res.data.data };
                            } catch (e) {
                                return { id, error: true };
                            }
                        })
                    );

                    setRunningStrategies(prev => {
                        const next = { ...prev };
                        let hasChanges = false;
                        updates.forEach(u => {
                            if (u.error || u.data.status === "COMPLETED" || u.data.status === "FAILED") {
                                if (next[u.id]) {
                                    delete next[u.id];
                                    hasChanges = true;
                                }
                            } else {
                                next[u.id] = u.data;
                                hasChanges = true;
                            }
                        });
                        return hasChanges ? next : prev;
                    });

                    // If any completed, refresh active lists
                    if (updates.some(u => !u.error && (u.data.status === "COMPLETED" || u.data.status === "FAILED"))) {
                        fetchActive();
                    }
                } catch (err) {
                    console.error("Error polling statuses:", err);
                }
            }, 3000);
        }
        return () => clearInterval(interval);
    }, [Object.keys(runningStrategies).length]);

    return (
        <div className="space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-8 h-12 bg-muted/50 p-1 rounded-2xl">
                    <TabsTrigger value="paper" className="rounded-xl font-bold data-[state=active]:bg-blue-600 data-[state=active]:text-white flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" /> Paper Trading
                    </TabsTrigger>
                    <TabsTrigger value="live" className="rounded-xl font-bold data-[state=active]:bg-orange-600 data-[state=active]:text-white flex items-center gap-2">
                        <Zap className="h-4 w-4" /> Live Market
                    </TabsTrigger>
                </TabsList>

                <Card className="w-full border-border bg-card overflow-hidden">
                    <CardHeader className="border-b bg-muted">
                        <CardTitle className="flex items-center gap-2 text-xl font-bold">
                            <Target className="h-5 w-5 text-primary" />
                            Strategy Configuration
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div className="space-y-2 lg:col-span-1">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                    <Target className="h-3 w-3" /> Strategy Name
                                </Label>
                                <Input
                                    className="h-11 rounded-xl"
                                    type="text"
                                    placeholder="E.g., Morning Breakout (CE)"
                                    value={config.name || ''}
                                    onChange={(e) => setConfig({ ...config, name: e.target.value })}
                                />
                            </div>
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
                                    const next = [...config.legs, { strike_criteria: 'STRIKE_TYPE', option_type: 'CE', strike: 'ATM', premium: 0, side: 'BUY', lots: 1, sl_type: 'PERCENTAGE', stop_loss: 10 }];
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
                                                    <Target className="h-3 w-3" /> Strike Criteria
                                                </Label>
                                                <Select
                                                    value={leg.strike_criteria || 'STRIKE_TYPE'}
                                                    onValueChange={(v) => {
                                                        const next = [...config.legs];
                                                        next[legIndex] = { ...next[legIndex], strike_criteria: v };
                                                        setConfig({ ...config, legs: next });
                                                    }}
                                                >
                                                    <SelectTrigger className="h-11 rounded-xl">
                                                        <SelectValue placeholder="Criteria" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="STRIKE_TYPE">Strike Type</SelectItem>
                                                        <SelectItem value="CLOSEST_PREMIUM">Closest Premium</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            {leg.strike_criteria === 'CLOSEST_PREMIUM' ? (
                                                <div className="space-y-2">
                                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                                        Premium (₹)
                                                    </Label>
                                                    <Input
                                                        className="h-11 rounded-xl"
                                                        type="text"
                                                        value={leg.premium === undefined ? '' : leg.premium}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                                const next = [...config.legs];
                                                                next[legIndex] = { ...next[legIndex], premium: val };
                                                                setConfig({ ...config, legs: next });
                                                            }
                                                        }}
                                                        onBlur={(e) => {
                                                            const next = [...config.legs];
                                                            next[legIndex] = { ...next[legIndex], premium: parseFloat(e.target.value) || 0 };
                                                            setConfig({ ...config, legs: next });
                                                        }}
                                                    />
                                                </div>
                                            ) : (
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
                                                            {Array.from({ length: 40 }, (_, i) => i + 1).map(n => (
                                                                <SelectItem key={`otm${legIndex}-${n}`} value={`OTM${n}`}>OTM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                                            ))}
                                                            {Array.from({ length: 40 }, (_, i) => i + 1).map(n => (
                                                                <SelectItem key={`itm${legIndex}-${n}`} value={`ITM${n}`}>ITM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                            )}

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

                                            <div className="space-y-2">
                                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">SL Type</Label>
                                                <Select
                                                    value={leg.sl_type || 'PERCENTAGE'}
                                                    onValueChange={(v) => {
                                                        const next = [...config.legs];
                                                        next[legIndex] = { ...next[legIndex], sl_type: v };
                                                        setConfig({ ...config, legs: next });
                                                    }}
                                                >
                                                    <SelectTrigger className="h-11 rounded-xl">
                                                        <SelectValue placeholder="SL Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                                        <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="space-y-2">
                                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                                    Stop Loss {leg.sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                </Label>
                                                <Input
                                                    className="h-11 rounded-xl"
                                                    type="number"
                                                    value={leg.stop_loss}
                                                    onChange={(e) => {
                                                        const next = [...config.legs];
                                                        next[legIndex] = { ...next[legIndex], stop_loss: parseFloat(e.target.value) };
                                                        setConfig({ ...config, legs: next });
                                                    }}
                                                />
                                            </div>

                                            {/* SL Margin removed - now using global entry_limit_offset */}
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
                                    step="1"
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
                                    step="1"
                                    value={config.exit_time}
                                    onChange={(e) => setConfig({ ...config, exit_time: e.target.value })}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                    Overall SL Type
                                </Label>
                                <Select value={config.overall_sl_type || 'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_sl_type: v })}>
                                    <SelectTrigger className="h-11 rounded-xl">
                                        <SelectValue placeholder="SL Type" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                        <SelectItem value="AMOUNT">Amount (₹)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                    Overall SL {config.overall_sl_type === 'AMOUNT' ? '(₹)' : '(%)'}
                                </Label>
                                <Input
                                    className="h-11 rounded-xl"
                                    type="text"
                                    value={config.overall_sl_value}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                            setConfig({ ...config, overall_sl_value: val });
                                        }
                                    }}
                                    onBlur={(e) => {
                                        setConfig({ ...config, overall_sl_value: parseFloat(e.target.value) || 0 });
                                    }}
                                />
                            </div>

                            {config.ordertype === 'LIMIT' ? (
                                <div className="space-y-2">
                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Limit Offset (LTP + )</Label>
                                    <Input
                                        className="h-11 rounded-xl"
                                        type="text"
                                        value={config.entry_limit_offset}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                setConfig({ ...config, entry_limit_offset: val });
                                            }
                                        }}
                                        onBlur={(e) => {
                                            setConfig({ ...config, entry_limit_offset: parseFloat(e.target.value) || 0 });
                                        }}
                                    />
                                </div>
                            ) : (config.ordertype !== 'MARKET' && config.ordertype !== 'STOPLOSS_MARKET' && (
                                <div className="space-y-2">
                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Price</Label>
                                    <Input
                                        className="h-11 rounded-xl"
                                        type="number"
                                        step="0.05"
                                        value={config.price}
                                        onChange={(e) => setConfig({ ...config, price: e.target.value })}
                                    />
                                </div>
                            ))}

                            {(config.ordertype === 'STOPLOSS_LIMIT' || config.ordertype === 'STOPLOSS_MARKET') && (
                                <div className="space-y-2">
                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Trigger Price</Label>
                                    <Input
                                        className="h-11 rounded-xl"
                                        type="number"
                                        step="0.05"
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
                    </CardContent >
                </Card >

                {
                    Object.entries(runningStrategies)
                        .filter(([_, data]) => (activeTab === 'paper' ? data.config?.is_paper_trading : !data.config?.is_paper_trading))
                        .map(([id, strategyData]) => (
                            <Card key={id} className={`w-full border-border animate-in fade-in slide-in-from-bottom-4 duration-500 ${activeTab === 'paper' ? 'bg-blue-50/50' : 'bg-orange-50/50'}`}>
                                <CardContent className="p-6 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-muted rounded-lg">
                                                    <Timer className="h-4 w-4 text-primary" />
                                                </div>
                                                <p className="text-sm font-bold">{strategyData.name || strategyData.config?.name || 'Strategy Execution'} <span className="text-xs font-mono text-muted-foreground ml-2">#{id.split('-')[0] || id}</span></p>
                                            </div>
                                            <div className="flex items-center gap-2 mt-2">
                                                <span className="relative flex h-2 w-2">
                                                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${strategyData.status === 'FAILED' ? 'bg-red-400' : 'bg-green-400'} opacity-75`}></span>
                                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${strategyData.status === 'FAILED' ? 'bg-red-500' : 'bg-green-500'}`}></span>
                                                </span>
                                                <span className="text-sm font-bold uppercase tracking-tight">{strategyData.status}</span>
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${strategyData.config?.is_paper_trading ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                                                    {strategyData.config?.is_paper_trading ? 'PAPER' : 'LIVE'}
                                                </span>
                                                <span className="text-xs font-bold text-muted-foreground ml-2">Index: {strategyData.config?.index}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {strategyData?.status === "IN_POSITION" && (
                                                <Button variant="outline" className="rounded-xl border-orange-500 hover:bg-orange-50 text-orange-600 font-bold" onClick={() => handleSquareOff(id)}>
                                                    Square Off
                                                </Button>
                                            )}
                                            <Button variant="outline" className="rounded-xl border-destructive hover:bg-red-50 text-destructive" onClick={() => handleStop(id)}>
                                                <StopCircle className="h-4 w-4 mr-2" /> Terminate
                                            </Button>
                                        </div>
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
                                            <div className={`p-3 rounded-xl ${(strategyData.totalPnlRupees || 0) >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                                                <span className="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Total PnL (₹)</span>
                                                <span className={`text-lg font-mono font-bold ${(strategyData.totalPnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                    {(strategyData.totalPnlRupees || 0) > 0 ? '+' : ''}{(strategyData.totalPnlRupees || 0).toFixed(2)}
                                                </span>
                                            </div>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>
                        ))
                }

                {
                    history.length > 0 && (
                        <Card className="w-full border-border bg-card mt-8">
                            <CardHeader className="border-b py-4 bg-muted/30">
                                <CardTitle className="text-lg font-bold flex items-center gap-2">
                                    <Save className="h-4 w-4 text-primary" /> Saved Strategies (Templates)
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted text-muted-foreground">
                                            <tr>
                                                <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Name</th>
                                                <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Date Created</th>
                                                <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Index</th>
                                                <th className="px-4 py-3 text-left font-bold text-xs uppercase tracking-wider">Type</th>
                                                <th className="px-4 py-3 text-right font-bold text-xs uppercase tracking-wider">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y border-t">
                                            {history
                                                .filter(s => (activeTab === 'paper' ? s.config?.is_paper_trading : !s.config?.is_paper_trading))
                                                .map((s) => (
                                                    <tr key={s.id} className="hover:bg-muted/50 transition-colors">
                                                        <td className="px-4 py-4 font-bold text-base">
                                                            {s.name || s.config?.name || 'Unnamed Strategy'}
                                                            <div className="text-[10px] font-mono text-muted-foreground font-normal mt-1">ID: {s.id.split('-')[0] || s.id}</div>
                                                        </td>
                                                        <td className="px-4 py-4 font-mono text-xs text-muted-foreground">
                                                            {new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </td>
                                                        <td className="px-4 py-4 font-bold">{s.config?.index}</td>
                                                        <td className="px-4 py-4">
                                                            <span className="px-2 py-1 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                                                                {s.config?.legs?.map((l) => `${l.side} ${l.option_type}`).join(' | ') || '---'}
                                                            </span>
                                                        </td>
                                                        <td className="px-4 py-4 text-right">
                                                            <div className="flex items-center justify-end gap-2">
                                                                <Button
                                                                    size="sm"
                                                                    className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold shadow-sm"
                                                                    onClick={() => handleExecute(s.id)}
                                                                >
                                                                    <Play className="h-3.5 w-3.5 fill-current" /> Deploy
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-8 px-3 gap-1 rounded-lg text-xs"
                                                                    onClick={() => handleEdit(s)}
                                                                >
                                                                    Edit
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    className="h-8 px-3 gap-1 rounded-lg text-xs text-destructive hover:text-destructive hover:bg-red-50"
                                                                    onClick={() => handleDelete(s.id)}
                                                                >
                                                                    <Trash2 className="h-3.5 w-3.5" />
                                                                </Button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    )}
            </Tabs>
        </div >
    );
};
