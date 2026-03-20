import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StopCircle, Loader2, TrendingUp, Search, Timer, LayoutDashboard, Target, Save, Play, Plus, Trash2, ShieldCheck, Zap, Copy, MessageSquare, Ghost, X, Settings2, Clock } from 'lucide-react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { StrategyLogs } from './StrategyLogs';
import { StrategyConfigModal } from './StrategyConfigModal';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5001/api";
const SOCKET_URL = API_BASE_URL.replace(/\/api\/?$/, "");

// Tier 1 - Rule 1 & Phase 2: Interceptor to ensuring session key is always sent
axios.interceptors.request.use((config) => {
    const sessionKey = sessionStorage.getItem('app_api_key');
    if (sessionKey && !config.headers['x-api-key']) {
        config.headers['x-api-key'] = sessionKey;
    }
    return config;
});

const DEFAULT_LEG = {
    strike_criteria: 'STRIKE_TYPE',
    option_type: 'CE',
    strike: 'ATM',
    premium: 0,
    side: 'BUY',
    lots: 1,
    sl_type: 'PERCENTAGE',
    stop_loss: 10,
    simple_mntm_enabled: false,
    simple_mntm_mode: 'SIMPLE_PLUS_PCT',
    simple_mntm_value: 0,
    recost_enabled: false,
    recost_mode: 'RECOST_PLUS_PCT',
    recost_value: 0,
    max_reentry: 1,
    reentry_sl_enabled: false,
    reentry_sl_type: 'PERCENTAGE',
    reentry_sl_value: 10,
    re_asap_enabled: false,
    re_asap_max_entries: 1,
    lazy_leg_enabled: false,
    lazy_leg: null,
    tsl_enabled: false,
    tsl_type: 'PERCENTAGE',
    tsl_value: 0,
    tsl_trail: 0
};


const getLegSummary = (leg) => {
    if (!leg) return 'Not configured';
    const strike = leg.strike_criteria === 'CLOSEST_PREMIUM' ? `₹${leg.premium || 0}` : (leg.strike || 'ATM');
    let summary = `${leg.side || 'BUY'} ${leg.option_type || 'CE'} ${strike} (SL ${leg.stop_loss || 0}${leg.sl_type === 'POINTS' ? 'pts' : '%'})`;
    if (leg.tsl_enabled) {
        summary += ` [TSL ${leg.tsl_value || 0}${leg.tsl_type === 'POINTS' ? 'pts' : '%'} | Trl: ${leg.tsl_trail || 0}]`;
    }
    return summary;
};

const LazyLegModal = ({ isOpen, onClose, leg, onChange, legIndex, level }) => {
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => { document.body.style.overflow = 'unset'; };
    }, [isOpen]);

    if (!isOpen) return null;

    const modalContent = (
        <div
            className="fixed inset-0 z-[999999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md transition-all duration-500 animate-in fade-in"
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="bg-white w-full max-w-4xl max-h-[90vh] flex flex-col rounded-[2.5rem] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.4)] border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-10 duration-500 ease-out">
                {/* Header */}
                <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 bg-orange-500 rounded-2xl flex items-center justify-center shadow-lg shadow-orange-200">
                            <Ghost className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h3 className="text-xl font-bold text-slate-900 tracking-tight">Configure Lazy Leg</h3>
                            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1 opacity-70">
                                Level {level} • Initial Leg Index {legIndex + 1}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-2xl hover:bg-slate-100 transition-all text-slate-400 hover:text-slate-900 border border-transparent hover:border-slate-200"
                    >
                        <X className="h-6 w-6" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-8 bg-slate-50/30">
                    <div className="max-w-3xl mx-auto">
                        <LegConfiguration
                            leg={leg}
                            legIndex={legIndex}
                            isRecursive={true}
                            level={level}
                            onChange={onChange}
                            onRemove={onClose}
                            canRemove={false}
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="px-8 py-5 bg-white border-t border-slate-100 flex items-center justify-end shrink-0 gap-3">
                    <Button variant="outline" onClick={onClose} className="rounded-xl px-6 font-bold h-12">
                        Cancel
                    </Button>
                    <Button onClick={onClose} className="rounded-xl px-8 font-bold h-12 shadow-lg shadow-primary/20">
                        Confirm Configuration
                    </Button>
                </div>
            </div>
            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
                @keyframes zoom-in-95 { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
                @keyframes slide-in-bottom-10 { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                .animate-in { animation-duration: 400ms; animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); animation-fill-mode: forwards; }
                .fade-in { animation-name: fade-in; }
                .zoom-in-95 { animation-name: zoom-in-95; }
                .slide-in-from-bottom-10 { animation-name: slide-in-bottom-10; }
            `}} />
        </div>
    );

    return createPortal(modalContent, document.body);
};


const LegConfiguration = ({ leg, legIndex, onChange, onRemove, onCopy, canRemove, isRecursive = false, level = 0 }) => {
    const idPrefix = isRecursive ? `lazy-${level}-${legIndex}` : `leg-${legIndex}`;
    const [isLazyModalOpen, setIsLazyModalOpen] = useState(false);

    return (
        <div className={`p-6 rounded-2xl border-2 transition-all duration-300 ${isRecursive ? 'bg-muted/30 border-dashed mt-4 ml-4 md:ml-8 border-primary/20' : 'bg-card border-primary/10 hover:border-primary/30 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className={`h-10 w-10 ${isRecursive ? 'bg-orange-500/10 text-orange-600' : 'bg-primary/10 text-primary'} rounded-xl flex items-center justify-center font-bold`}>
                        {isRecursive ? <Ghost className="h-5 w-5" /> : legIndex + 1}
                    </div>
                    <div>
                        <h3 className="font-bold text-lg tracking-tight">
                            {isRecursive ? `Lazy Leg (Level ${level})` : `Strategy Leg ${legIndex + 1}`}
                        </h3>
                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                            {isRecursive ? 'Placed after parent SL hits' : 'Initial Entry Leg'}
                        </p>
                    </div>
                </div>
                {!isRecursive && (
                    <div className="flex items-center gap-1">
                        <Button
                            type="button"
                            variant="ghost"
                            className="h-8 px-2 text-primary hover:text-primary/80"
                            onClick={onCopy}
                            title="Copy leg"
                        >
                            <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            className="h-8 px-2 text-destructive"
                            onClick={onRemove}
                            disabled={!canRemove}
                            title={!canRemove ? "At least one leg is required" : "Remove leg"}
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                )}
                {isRecursive && (
                    <Button
                        type="button"
                        variant="ghost"
                        className="h-8 px-2 text-destructive"
                        onClick={onRemove}
                        title="Remove Lazy Leg"
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        <TrendingUp className="h-3 w-3" /> Option Type
                    </Label>
                    <Select
                        value={leg.option_type}
                        onValueChange={(v) => onChange({ ...leg, option_type: v })}
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
                        onValueChange={(v) => onChange({ ...leg, strike_criteria: v })}
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
                                    onChange({ ...leg, premium: val });
                                }
                            }}
                            onBlur={(e) => onChange({ ...leg, premium: parseFloat(e.target.value) || 0 })}
                        />
                    </div>
                ) : (
                    <div className="space-y-2">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                            <Target className="h-3 w-3" /> Strike
                        </Label>
                        <Select
                            value={leg.strike}
                            onValueChange={(v) => onChange({ ...leg, strike: v })}
                        >
                            <SelectTrigger className="h-11 rounded-xl">
                                <SelectValue placeholder="Select Strike" />
                            </SelectTrigger>
                            <SelectContent className="max-h-[300px]">
                                <SelectItem value="ATM">ATM (At the Money)</SelectItem>
                                {Array.from({ length: 40 }, (_, i) => i + 1).map(n => (
                                    <SelectItem key={`${idPrefix}-otm-${n}`} value={`OTM${n}`}>OTM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                ))}
                                {Array.from({ length: 40 }, (_, i) => i + 1).map(n => (
                                    <SelectItem key={`${idPrefix}-itm-${n}`} value={`ITM${n}`}>ITM {n} strike{n > 1 ? 's' : ''} away</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Side</Label>
                    <Select
                        value={leg.side}
                        onValueChange={(v) => onChange({ ...leg, side: v })}
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
                        onChange={(e) => onChange({ ...leg, lots: parseInt(e.target.value) })}
                    />
                </div>

                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">SL Type</Label>
                    <Select
                        value={leg.sl_type || 'PERCENTAGE'}
                        onValueChange={(v) => onChange({ ...leg, sl_type: v })}
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
                        onChange={(e) => onChange({ ...leg, stop_loss: parseFloat(e.target.value) })}
                    />
                </div>

                <div className="space-y-2 md:col-span-2 lg:col-span-2">
                    <div className="flex items-center justify-between mb-1.5">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Trailing Stop Loss</Label>
                        <div className="flex items-center gap-1.5">
                            <input
                                type="checkbox"
                                id={`tsl-enabled-${idPrefix}`}
                                className="w-3 h-3 rounded text-blue-600 cursor-pointer"
                                checked={leg.tsl_enabled || false}
                                onChange={(e) => onChange({ ...leg, tsl_enabled: e.target.checked })}
                            />
                            <Label htmlFor={`tsl-enabled-${idPrefix}`} className="text-[10px] font-bold tracking-wide cursor-pointer uppercase">
                                Enable
                            </Label>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Select
                            value={leg.tsl_type || 'PERCENTAGE'}
                            onValueChange={(v) => onChange({ ...leg, tsl_type: v })}
                            disabled={!leg.tsl_enabled}
                        >
                            <SelectTrigger className="h-11 rounded-md w-[30%]">
                                <SelectValue placeholder="Type" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                <SelectItem value="POINTS">Points</SelectItem>
                            </SelectContent>
                        </Select>

                        <div className="flex-1 relative">
                            <Input
                                className="h-11 rounded-md w-full"
                                type="number"
                                placeholder="Move"
                                value={leg.tsl_value === 0 ? '' : (leg.tsl_value !== undefined ? leg.tsl_value : '')}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    onChange({ ...leg, tsl_value: val === '' ? 0 : parseFloat(val) });
                                }}
                                disabled={!leg.tsl_enabled}
                                title={`TSL Move (${leg.tsl_type === 'POINTS' ? 'Pts' : '%'})`}
                            />
                        </div>

                        <div className="flex-1 relative">
                            <Input
                                className="h-11 rounded-md w-full"
                                type="number"
                                placeholder="Trail"
                                value={leg.tsl_trail === 0 ? '' : (leg.tsl_trail !== undefined ? leg.tsl_trail : '')}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    onChange({ ...leg, tsl_trail: val === '' ? 0 : parseFloat(val) });
                                }}
                                disabled={!leg.tsl_enabled}
                                title={`TSL Trail (${leg.tsl_type === 'POINTS' ? 'Pts' : '%'})`}
                            />
                        </div>
                    </div>
                </div>

                <div className="md:col-span-2 space-y-4 pt-4 border-t border-dashed mt-2">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id={`simple-mntm-${idPrefix}`}
                            className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                            checked={leg.simple_mntm_enabled || false}
                            onChange={(e) => onChange({
                                ...leg,
                                simple_mntm_enabled: e.target.checked,
                                simple_mntm_mode: leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT',
                                simple_mntm_value: leg.simple_mntm_value || 0
                            })}
                        />
                        <Label htmlFor={`simple-mntm-${idPrefix}`} className="text-sm font-bold tracking-wide text-foreground cursor-pointer flex items-center gap-1.5">
                            Simple Momentum
                        </Label>
                    </div>

                    {leg.simple_mntm_enabled && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-6 animate-in slide-in-from-top-2">
                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Simple Mntm Mode</Label>
                                <Select
                                    value={leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT'}
                                    onValueChange={(v) => onChange({ ...leg, simple_mntm_mode: v })}
                                >
                                    <SelectTrigger className="h-11 rounded-xl">
                                        <SelectValue placeholder="Mode" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="SIMPLE_PLUS_PCT">SIMPLE + %</SelectItem>
                                        <SelectItem value="SIMPLE_PLUS_PTS">SIMPLE + Pts</SelectItem>
                                        <SelectItem value="SIMPLE_MINUS_PCT">SIMPLE - %</SelectItem>
                                        <SelectItem value="SIMPLE_MINUS_PTS">SIMPLE - Pts</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                    Mntm Value {leg.simple_mntm_mode && leg.simple_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                </Label>
                                <Input
                                    className="h-11 rounded-xl"
                                    type="text"
                                    value={leg.simple_mntm_value === undefined ? '' : leg.simple_mntm_value}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                            onChange({ ...leg, simple_mntm_value: val });
                                        }
                                    }}
                                    onBlur={(e) => onChange({ ...leg, simple_mntm_value: parseFloat(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                    )}

                    <div className="h-4"></div>

                    {/* Exclusivity: RE-ASAP, RE-COST, LAZY LEG */}
                    <div className="grid grid-cols-1 gap-4">
                        {/* RE-ASAP */}
                        <div className={`space-y-4 pt-4 border-t transition-all duration-300 ${(leg.recost_enabled || leg.lazy_leg_enabled) ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id={`re-asap-${idPrefix}`}
                                    className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    checked={leg.re_asap_enabled || false}
                                    disabled={leg.recost_enabled || leg.lazy_leg_enabled}
                                    onChange={(e) => onChange({
                                        ...leg,
                                        re_asap_enabled: e.target.checked,
                                        re_asap_max_entries: leg.re_asap_max_entries || 1,
                                        recost_enabled: false,
                                        lazy_leg_enabled: false
                                    })}
                                />
                                <Label htmlFor={`re-asap-${idPrefix}`} className={`text-sm font-bold tracking-wide text-foreground flex items-center gap-1.5 ${(leg.recost_enabled || leg.lazy_leg_enabled) ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                                    RE-ASAP
                                </Label>
                            </div>
                            {leg.re_asap_enabled && (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-6 animate-in slide-in-from-top-2">
                                    <div className="space-y-2">
                                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Max Entries</Label>
                                        <Select
                                            value={(leg.re_asap_max_entries || 1).toString()}
                                            onValueChange={(v) => onChange({ ...leg, re_asap_max_entries: parseInt(v) })}
                                        >
                                            <SelectTrigger className="h-11 rounded-xl">
                                                <SelectValue placeholder="Entries" />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-[250px]">
                                                {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                    <SelectItem key={`${idPrefix}-max-re-asap-${num}`} value={num.toString()}>
                                                        {num} {num === 1 ? 'Entry' : 'Entries'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* RE-COST */}
                        <div className={`space-y-4 pt-4 border-t transition-all duration-300 ${(leg.re_asap_enabled || leg.lazy_leg_enabled) ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id={`recost-${idPrefix}`}
                                    className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    checked={leg.recost_enabled || false}
                                    disabled={leg.re_asap_enabled || leg.lazy_leg_enabled}
                                    onChange={(e) => onChange({
                                        ...leg,
                                        recost_enabled: e.target.checked,
                                        re_asap_enabled: false,
                                        lazy_leg_enabled: false,
                                        recost_mode: leg.recost_mode || 'RECOST_PLUS_PCT',
                                        recost_value: leg.recost_value || 0,
                                        max_reentry: leg.max_reentry || 1,
                                        reentry_sl_enabled: leg.reentry_sl_enabled || false,
                                        reentry_sl_type: leg.reentry_sl_type || 'PERCENTAGE',
                                        reentry_sl_value: leg.reentry_sl_value || leg.stop_loss || 0
                                    })}
                                />
                                <Label htmlFor={`recost-${idPrefix}`} className={`text-sm font-bold tracking-wide text-foreground ${(leg.re_asap_enabled || leg.lazy_leg_enabled) ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                                    RE-COST
                                </Label>
                            </div>
                            {leg.recost_enabled && (
                                <div className="space-y-4 pl-6 animate-in slide-in-from-top-2">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Re-Cost Mode</Label>
                                            <Select
                                                value={leg.recost_mode || 'RECOST_PLUS_PCT'}
                                                onValueChange={(v) => onChange({ ...leg, recost_mode: v })}
                                            >
                                                <SelectTrigger className="h-11 rounded-xl">
                                                    <SelectValue placeholder="Mode" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="RECOST_PLUS_PCT">RECOST + %</SelectItem>
                                                    <SelectItem value="RECOST_PLUS_PTS">RECOST + Pts</SelectItem>
                                                    <SelectItem value="RECOST_MINUS_PCT">RECOST - %</SelectItem>
                                                    <SelectItem value="RECOST_MINUS_PTS">RECOST - Pts</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                                Value {leg.recost_mode && leg.recost_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                            </Label>
                                            <Input
                                                className="h-11 rounded-xl"
                                                type="text"
                                                value={leg.recost_value === undefined ? '' : leg.recost_value}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                        onChange({ ...leg, recost_value: val });
                                                    }
                                                }}
                                                onBlur={(e) => onChange({ ...leg, recost_value: parseFloat(e.target.value) || 0 })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Max Entries</Label>
                                            <Select
                                                value={(leg.max_reentry || 1).toString()}
                                                onValueChange={(v) => onChange({ ...leg, max_reentry: parseInt(v) })}
                                            >
                                                <SelectTrigger className="h-11 rounded-xl">
                                                    <SelectValue placeholder="Entries" />
                                                </SelectTrigger>
                                                <SelectContent className="max-h-[250px]">
                                                    {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                        <SelectItem key={`${idPrefix}-max-recost-${num}`} value={num.toString()}>
                                                            {num} {num === 1 ? 'Entry' : 'Entries'}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                id={`reentry-mntm-${idPrefix}`}
                                                className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                                checked={leg.recost_mntm_enabled || false}
                                                onChange={(e) => onChange({
                                                    ...leg,
                                                    recost_mntm_enabled: e.target.checked,
                                                    recost_mntm_mode: leg.recost_mntm_mode || 'RECOST_PLUS_PCT',
                                                    recost_mntm_value: leg.recost_mntm_value || 0
                                                })}
                                            />
                                            <Label htmlFor={`reentry-mntm-${idPrefix}`} className="text-xs font-bold tracking-wide text-foreground cursor-pointer">
                                                Re Entry Mntm
                                            </Label>
                                        </div>
                                        {leg.recost_mntm_enabled && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-6 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                                <div className="space-y-2">
                                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Mntm Mode</Label>
                                                    <Select
                                                        value={leg.recost_mntm_mode || 'RECOST_PLUS_PCT'}
                                                        onValueChange={(v) => onChange({ ...leg, recost_mntm_mode: v })}
                                                    >
                                                        <SelectTrigger className="h-11 rounded-xl">
                                                            <SelectValue placeholder="Mode" />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="RECOST_PLUS_PCT">RTP + %</SelectItem>
                                                            <SelectItem value="RECOST_PLUS_PTS">RTP + Pts</SelectItem>
                                                            <SelectItem value="RECOST_MINUS_PCT">RTP - %</SelectItem>
                                                            <SelectItem value="RECOST_MINUS_PTS">RTP - Pts</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="space-y-2">
                                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                                                        Value {leg.recost_mntm_mode && leg.recost_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                                    </Label>
                                                    <Input
                                                        className="h-11 rounded-xl"
                                                        type="text"
                                                        value={leg.recost_mntm_value === undefined ? '' : leg.recost_mntm_value}
                                                        onChange={(e) => {
                                                            const val = e.target.value;
                                                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                                onChange({ ...leg, recost_mntm_value: val });
                                                            }
                                                        }}
                                                        onBlur={(e) => onChange({ ...leg, recost_mntm_value: parseFloat(e.target.value) || 0 })}
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                id={`reentry-sl-${idPrefix}`}
                                                className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                                checked={leg.reentry_sl_enabled || false}
                                                onChange={(e) => onChange({ ...leg, reentry_sl_enabled: e.target.checked })}
                                            />
                                            <Label htmlFor={`reentry-sl-${idPrefix}`} className="text-xs font-bold tracking-wide text-foreground cursor-pointer">
                                                Override Stop Loss on Re-Entry
                                            </Label>
                                        </div>
                                        {leg.reentry_sl_enabled && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-6 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                                <div className="space-y-2">
                                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">New SL Type</Label>
                                                    <Select
                                                        value={leg.reentry_sl_type || 'PERCENTAGE'}
                                                        onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
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
                                                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                                                        New SL Value {leg.reentry_sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                    </Label>
                                                    <Input
                                                        className="h-11 rounded-xl"
                                                        type="number"
                                                        value={leg.reentry_sl_value !== undefined ? leg.reentry_sl_value : (leg.stop_loss || 0)}
                                                        onChange={(e) => onChange({ ...leg, reentry_sl_value: parseFloat(e.target.value) })}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* LAZY LEG */}
                        <div className={`space-y-4 pt-4 border-t transition-all duration-300 ${(leg.re_asap_enabled || leg.recost_enabled) ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id={`lazy-leg-${idPrefix}`}
                                    className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    checked={leg.lazy_leg_enabled || false}
                                    disabled={leg.re_asap_enabled || leg.recost_enabled}
                                    onChange={(e) => onChange({
                                        ...leg,
                                        lazy_leg_enabled: e.target.checked,
                                        re_asap_enabled: false,
                                        recost_enabled: false,
                                        lazy_leg: e.target.checked ? (leg.lazy_leg || { ...DEFAULT_LEG }) : leg.lazy_leg
                                    })}
                                />
                                <Label htmlFor={`lazy-leg-${idPrefix}`} className={`text-sm font-bold tracking-wide text-foreground flex items-center gap-1.5 ${(leg.re_asap_enabled || leg.recost_enabled) ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                                    LAZY LEG
                                </Label>
                            </div>

                            {leg.lazy_leg_enabled && leg.lazy_leg && (
                                <div className="animate-in slide-in-from-top-2">
                                    <div className="flex items-center justify-between p-4 bg-orange-50/50 border border-orange-200 rounded-2xl group hover:border-orange-300 transition-all cursor-pointer" onClick={() => setIsLazyModalOpen(true)}>
                                        <div className="flex items-center gap-3">
                                            <div className="h-10 w-10 bg-orange-500/10 text-orange-600 rounded-xl flex items-center justify-center">
                                                <Ghost className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <p className="text-xs font-bold text-orange-600 uppercase tracking-widest">Lazy Leg Level {level + 1}</p>
                                                <p className="text-sm font-bold text-slate-700">{getLegSummary(leg.lazy_leg)}</p>
                                            </div>
                                        </div>
                                        <Button variant="ghost" size="sm" className="rounded-xl group-hover:bg-orange-100/50">
                                            <Settings2 className="h-4 w-4 mr-2" /> Configure
                                        </Button>
                                    </div>
                                    <LazyLegModal
                                        isOpen={isLazyModalOpen}
                                        onClose={() => setIsLazyModalOpen(false)}
                                        leg={leg.lazy_leg}
                                        onChange={(newLazyLeg) => onChange({ ...leg, lazy_leg: newLazyLeg })}
                                        legIndex={legIndex}
                                        level={level + 1}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const EntryTimer = ({ entryTime }) => {
    const [timeLeft, setTimeLeft] = useState('');

    useEffect(() => {
        if (!entryTime) return;
        const parts = entryTime.split(':');
        const targetHours = parseInt(parts[0], 10);
        const targetMinutes = parseInt(parts[1], 10);
        const targetSeconds = parseInt(parts[2] || 0, 10);

        const updateTimer = () => {
            const now = new Date();
            let target = new Date();
            target.setHours(targetHours, targetMinutes, targetSeconds, 0);

            let diff = target - now;
            if (diff < 0) {
                setTimeLeft('...');
                return;
            }

            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            let timeString = '';
            if (hours > 0) timeString += `${hours}h `;
            if (minutes > 0 || hours > 0) timeString += `${minutes}m `;
            timeString += `${seconds}s`;

            setTimeLeft(`in ${timeString.trim()}`);
        };

        updateTimer();
        const interval = setInterval(updateTimer, 1000);
        return () => clearInterval(interval);
    }, [entryTime]);

    return (
        <div className="flex items-center gap-1 px-1.5 py-0.5 ml-1 bg-indigo-50 text-indigo-700 font-bold rounded border border-indigo-100/60 shadow-sm animate-pulse">
            <Clock className="h-3 w-3" />
            <span className="text-[10px] tracking-wide uppercase">Entry at {entryTime} {timeLeft ? `(${timeLeft})` : ''}</span>
        </div>
    );
};

// Tier 1 - Rule 1 & Phase 2: Interceptor to ensuring session key is always sent


export const StrategyFormContent = ({ config, setConfig, editingId, setEditingId, loading, handleSave, isReadOnly }) => {
    return (
        <div className={isReadOnly ? "read-only-form opacity-90" : ""}>
            <style>{`
                .read-only-form input,
                .read-only-form [role="combobox"],
                .read-only-form label,
                .read-only-form [type="checkbox"] {
                    pointer-events: none !important;
                }
                .read-only-form .hide-on-readonly {
                    opacity: 0.5 !important;
                    pointer-events: none !important;
                    display: none !important;
                }
            `}</style>
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

            <div className="flex items-center justify-between pt-6 hide-on-readonly">
                <div className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Strategy Legs
                </div>
                <Button
                    type="button"
                    variant="outline"
                    className="h-9 gap-2 rounded-xl"
                    onClick={() => {
                        const next = [...config.legs, { ...DEFAULT_LEG }];
                        setConfig({ ...config, legs: next });
                    }}
                >
                    <Plus className="h-4 w-4" /> Add Leg
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
                {config.legs.map((leg, legIndex) => (
                    <LegConfiguration
                        key={`leg-config-${legIndex}`}
                        leg={leg}
                        legIndex={legIndex}
                        canRemove={config.legs.length > 1}
                        onChange={(updatedLeg) => {
                            const next = [...config.legs];
                            next[legIndex] = updatedLeg;
                            setConfig({ ...config, legs: next });
                        }}
                        onRemove={() => {
                            const next = config.legs.filter((_, i) => i !== legIndex);
                            setConfig({ ...config, legs: next });
                        }}
                        onCopy={() => {
                            const next = [...config.legs];
                            next.splice(legIndex + 1, 0, JSON.parse(JSON.stringify(leg)));
                            setConfig({ ...config, legs: next });
                        }}
                    />
                ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 pt-6">

                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Variety</Label>
                    <Select value={config.variety} onValueChange={(v) => setConfig({ ...config, variety: v })}>
                        <SelectTrigger className="h-11 rounded-xl">
                            <SelectValue placeholder="Variety" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="STOPLOSS">STOPLOSS</SelectItem>
                            {/* <SelectItem value="NORMAL">NORMAL</SelectItem> */}
                            {/* <SelectItem value="ROBO">ROBO</SelectItem> */}
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
                            {/* <SelectItem value="DELIVERY">DELIVERY (CNC)</SelectItem> */}
                            {/* <SelectItem value="MARGIN">MARGIN</SelectItem> */}
                            {/* <SelectItem value="BO">BO (Bracket Order)</SelectItem> */}
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
                            {/* <SelectItem value="STOPLOSS_LIMIT">SL-L</SelectItem> */}
                            {/* <SelectItem value="STOPLOSS_MARKET">SL-M</SelectItem> */}
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
                            {/* <SelectItem value="IOC">IOC</SelectItem> */}
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

                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        Overall Target Type
                    </Label>
                    <Select value={config.overall_target_type || 'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_target_type: v })}>
                        <SelectTrigger className="h-11 rounded-xl">
                            <SelectValue placeholder="Target Type" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                            <SelectItem value="AMOUNT">Amount (₹)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-2">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        Overall Target {config.overall_target_type === 'AMOUNT' ? '(₹)' : '(%)'}
                    </Label>
                    <Input
                        className="h-11 rounded-xl"
                        type="text"
                        value={config.overall_target_value}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                setConfig({ ...config, overall_target_value: val });
                            }
                        }}
                        onBlur={(e) => {
                            setConfig({ ...config, overall_target_value: parseFloat(e.target.value) || 0 });
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

                <div className="flex items-end hide-on-readonly">
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
                    <div className="flex items-end hide-on-readonly">
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
        </div>
    );
};

export const StrategyBuilder = ({ isConnected }) => {
    const [loading, setLoading] = useState(false);
    const [runningStrategies, setRunningStrategies] = useState({}); // { id: data }
    const [savedStrategies, setSavedStrategies] = useState([]);
    const [editingId, setEditingId] = useState(null);
    const [activeTab, setActiveTab] = useState('paper');
    const [logWindowOpen, setLogWindowOpen] = useState(false);
    const [logStrategyId, setLogStrategyId] = useState(null);
    const [configWindowOpen, setConfigWindowOpen] = useState(false);
    const [viewConfig, setViewConfig] = useState(null);
    const [viewStrategyName, setViewStrategyName] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    const [config, setConfig] = useState({
        name: '',
        index: 'NIFTY',
        entry_time: '09:16:00',
        exit_time: '15:29:00',
        variety: 'STOPLOSS',
        ordertype: 'LIMIT',
        producttype: 'CARRYFORWARD',
        duration: 'DAY',
        price: '0',
        triggerprice: '0',
        squareoff: '0',
        stoploss: '0',
        overall_sl_type: 'PERCENTAGE',
        overall_sl_value: 0,
        overall_target_type: 'PERCENTAGE',
        overall_target_value: 0,
        entry_limit_offset: 0,
        legs: [
            { strike_criteria: 'STRIKE_TYPE', option_type: 'CE', strike: 'ATM', premium: 0, side: 'BUY', lots: 1, sl_type: 'PERCENTAGE', stop_loss: 10, simple_mntm_enabled: false, simple_mntm_mode: 'SIMPLE_PLUS_PCT', simple_mntm_value: 0, recost_enabled: false, recost_mode: 'RECOST_PLUS_PCT', recost_value: 0, max_reentry: 1, reentry_sl_enabled: false, reentry_sl_type: 'PERCENTAGE', reentry_sl_value: 10, re_asap_enabled: false, re_asap_max_entries: 1, lazy_leg_enabled: false, lazy_leg: null, tsl_enabled: false, tsl_type: 'PERCENTAGE', tsl_value: 0 }
        ]
    });

    const fetchSavedStrategies = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/user`);
            setSavedStrategies(res.data?.data || []);
        } catch (err) {
            console.error("Error fetching saved strategies:", err);
        }
    };

    const fetchActive = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/active`);
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
        fetchSavedStrategies();
    }, []);

    React.useEffect(() => {
        if (isConnected) {
            fetchActive();
        } else {
            setRunningStrategies({});
        }
    }, [isConnected]);

    const handleSave = async () => {
        setLoading(true);
        const finalConfig = { ...config, is_paper_trading: activeTab === 'paper' };
        try {
            if (editingId) {
                await axios.put(`${API_BASE_URL}/strategy/update/${editingId}`, finalConfig);
                setEditingId(null);
            } else {
                await axios.post(`${API_BASE_URL}/strategy/save`, finalConfig);
            }
            fetchSavedStrategies();
        } catch (err) {
            const validationErrors = err.response?.data?.errors;
            if (validationErrors && Array.isArray(validationErrors)) {
                const errorMsg = validationErrors.map(e => `${e.path}: ${e.msg}`).join('\n');
                alert("Validation Error:\n" + errorMsg);
            } else {
                alert("Error saving strategy: " + (err.response?.data?.message || err.message));
            }
        } finally {
            setLoading(false);
        }
    };

    const handleExecute = async (id) => {
        if (!isConnected) {
            alert("Please connect to Angel One to execute strategies.");
            return;
        }
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
            // We no longer call fetchSavedStrategies() here because execution doesn't create a new template
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

    const handleSquareOffLeg = async (id, legIndex) => {
        if (!id) return;
        if (!confirm("Are you sure you want to instantly square off this specific leg?")) return;
        try {
            await axios.post(`${API_BASE_URL}/strategy/squareoff/${id}/leg/${legIndex}`);
            fetchActive();
        } catch (err) {
            alert("Error squaring off leg: " + err.response?.data?.message || err.message);
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
            fetchSavedStrategies();
        } catch (err) {
            alert("Error deleting strategy: " + err.message);
        }
    };

    // Helper to keep frontend PnL snappy with WebSocket updates
    const recalculateStrategyPnL = (strategy) => {
        if (!strategy || !strategy.legs) return strategy;

        const updatedLegs = strategy.legs.map(l => {
            // We only recalculate for legs that have an entry price and haven't fully exited yet in the UI
            if (l.entryPrice && !l.exited) {
                const curLtp = l.currentLtp || 0;
                const entry = l.entryPrice || 1;
                const side = l.leg?.side || "SELL";
                const pnlPoints = side === "BUY" ? (curLtp - entry) : (entry - curLtp);
                const quantity = (l.leg?.lots || 0) * (parseInt(l.instrument?.lotsize) || 1);

                const curActiveRupees = pnlPoints * quantity;
                const curActivePercent = (pnlPoints / entry) * 100;

                const totalPoints = (l.bookedPnlPoints || 0) + pnlPoints;
                const totalRupees = (l.bookedPnlRupees || 0) + curActiveRupees;
                const totalPercent = l.original_traded_price > 0 ? (totalPoints / l.original_traded_price * 100) : 0;

                return {
                    ...l,
                    currentActivePnlPoints: pnlPoints,
                    currentActivePnlRupees: curActiveRupees,
                    currentActivePnlPercent: curActivePercent,
                    pnlPoints: totalPoints,
                    pnlRupees: totalRupees,
                    pnlPercent: totalPercent
                };
            }
            return l;
        });

        const totalPnlRupees = updatedLegs.reduce((sum, l) => sum + (l.pnlRupees || 0), 0);
        const totalOriginalValue = updatedLegs.reduce((sum, l) => {
            if (!l.original_traded_price) return sum;
            const quantity = (l.leg?.lots || 0) * (parseInt(l.instrument?.lotsize) || 1);
            return sum + (l.original_traded_price * quantity);
        }, 0);

        const avgPnl = totalOriginalValue > 0 ? (totalPnlRupees / totalOriginalValue) * 100 : 0;

        return {
            ...strategy,
            legs: updatedLegs,
            totalPnlRupees,
            totalOriginalValue,
            pnlPercent: avgPnl
        };
    };

    // Tier 1 - Live Streaming: WebSocket initialization
    useEffect(() => {
        console.log("[Socket] Connecting to:", SOCKET_URL);
        const socket = io(SOCKET_URL, {
            autoConnect: true,
            reconnection: true
        });

        socket.on('ltp_update', (data) => {
            setRunningStrategies(prev => {
                let next = { ...prev };
                let overallHasChanges = false;

                Object.keys(next).forEach(id => {
                    const strategy = next[id];
                    if (strategy.legs) {
                        let strategyLegsChanged = false;
                        const updatedLegs = strategy.legs.map(leg => {
                            if (leg.instrument.token === data.token &&
                                (leg.instrument.exch_seg === data.exchange || leg.instrument.exchange === data.exchange)) {
                                if (leg.currentLtp !== data.ltp) {
                                    strategyLegsChanged = true;
                                    return { ...leg, currentLtp: data.ltp };
                                }
                            }
                            return leg;
                        });

                        if (strategyLegsChanged) {
                            // Immediate recalculation of overall PnL on every tick
                            next[id] = recalculateStrategyPnL({ ...strategy, legs: updatedLegs });
                            overallHasChanges = true;
                        }
                    }
                });

                return overallHasChanges ? next : prev;
            });
        });

        socket.on('strategy_log', (data) => {
            setRunningStrategies(prev => {
                if (!prev[data.strategyId]) return prev;
                const strategy = prev[data.strategyId];
                const updatedLogs = [...(strategy.logs || []), data.log];
                return {
                    ...prev,
                    [data.strategyId]: { ...strategy, logs: updatedLogs }
                };
            });
        });

        socket.on('connect', () => console.log('WebSocket Connected'));

        return () => {
            socket.disconnect();
        };
    }, []);

    useEffect(() => {
        let interval;
        if (isConnected && Object.keys(runningStrategies).length > 0) {
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
                        let next = { ...prev };
                        let hasChanges = false;

                        updates.forEach(u => {
                            if (u.error || u.data.status === "COMPLETED" || u.data.status === "FAILED") {
                                if (next[u.id]) {
                                    delete next[u.id];
                                    hasChanges = true;
                                }
                            } else {
                                const existing = next[u.id];
                                // Add if new, or update if status changed
                                if (!existing || existing.status !== u.data.status) {
                                    next[u.id] = u.data;
                                    hasChanges = true;
                                } else {
                                    // Periodic refresh of non-price data (pnl, etc)
                                    // We merge u.data (latest DB state) with our local memory (carrying LTPs)
                                    // and then perform a local PnL recalculation to keep it snappy.
                                    const latestLegs = u.data.legs || [];
                                    const mergedStrategy = {
                                        ...u.data,
                                        legs: latestLegs.map(newLeg => {
                                            // Try to find matching leg in our current memory to preserve its fast price
                                            const existingLeg = existing.legs?.find(ex => ex.instrument.token === newLeg.instrument.token);
                                            return {
                                                ...newLeg,
                                                currentLtp: existingLeg ? (existingLeg.currentLtp || newLeg.currentLtp) : newLeg.currentLtp
                                            };
                                        })
                                    };
                                    next[u.id] = recalculateStrategyPnL(mergedStrategy);
                                    hasChanges = true;
                                }
                            }
                        });
                        return hasChanges ? next : prev;
                    });

                    if (updates.some(u => !u.error && (u.data.status === "COMPLETED" || u.data.status === "FAILED"))) {
                        fetchActive();
                    }
                } catch (err) {
                    console.error("Error polling statuses:", err);
                }
            }, 5000); // Polling every 5s for reliable status sync
        }
        return () => clearInterval(interval);
    }, [Object.keys(runningStrategies).length, isConnected]);

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
                        <StrategyFormContent config={config} setConfig={setConfig} editingId={editingId} setEditingId={setEditingId} loading={loading} handleSave={handleSave} isReadOnly={false} />
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
                                                {strategyData.status === 'WAITING' && strategyData.config?.entry_time && (
                                                    <EntryTimer entryTime={strategyData.config.entry_time} />
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold border-indigo-500 hover:bg-indigo-50 text-indigo-600 shadow-sm"
                                                onClick={() => {
                                                    setViewConfig(strategyData.config);
                                                    setViewStrategyName(strategyData.name || strategyData.config?.name || 'Strategy');
                                                    setConfigWindowOpen(true);
                                                }}
                                            >
                                                <Settings2 className="h-3.5 w-3.5" />
                                                View
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold border-blue-500 hover:bg-blue-50 text-blue-600 shadow-sm"
                                                onClick={() => {
                                                    setLogStrategyId(id);
                                                    setLogWindowOpen(true);
                                                }}
                                            >
                                                <MessageSquare className="h-3.5 w-3.5" />
                                                Logs
                                            </Button>
                                            {strategyData?.status === "IN_POSITION" && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold border-orange-500 hover:bg-orange-50 text-orange-600 shadow-sm"
                                                    onClick={() => handleSquareOff(id)}
                                                >
                                                    Square Off
                                                </Button>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold border-destructive hover:bg-red-50 text-destructive shadow-sm"
                                                onClick={() => handleStop(id)}
                                            >
                                                <StopCircle className="h-3.5 w-3.5" /> Terminate
                                            </Button>
                                        </div>
                                    </div>

                                    {strategyData?.status === "IN_POSITION" || strategyData?.status === "COMPLETED" ? (
                                        <div className="space-y-4 pt-4 border-t border-border">
                                            {/* Overall Strategy PnL Summary */}
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                                <div className={`p-4 rounded-xl flex flex-col justify-center items-center ${(strategyData.pnlPercent || 0) >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                                                    <span className="text-xs font-bold uppercase text-muted-foreground mb-1">Overall Return (%)</span>
                                                    <span className={`text-2xl font-mono font-bold transition-all duration-300 ${(strategyData.pnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                        {(strategyData.pnlPercent || 0) > 0 ? '+' : ''}{(strategyData.pnlPercent || 0).toFixed(3)}%
                                                    </span>
                                                </div>
                                                <div className={`p-4 rounded-xl flex flex-col justify-center items-center ${(strategyData.totalPnlRupees || 0) >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                                                    <span className="text-xs font-bold uppercase text-muted-foreground mb-1">Overall PnL (₹)</span>
                                                    <span className={`text-2xl font-mono font-bold transition-all duration-300 ${(strategyData.totalPnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                        {(strategyData.totalPnlRupees || 0) > 0 ? '+' : ''}{(strategyData.totalPnlRupees || 0).toFixed(2)}
                                                    </span>
                                                </div>
                                                <div className="p-4 rounded-xl flex flex-col justify-center items-center bg-slate-50 border border-slate-100">
                                                    <span className="text-xs font-bold uppercase text-muted-foreground mb-1">Total Entry Value</span>
                                                    <span className="text-2xl font-mono font-bold text-slate-700">
                                                        ₹{(strategyData.totalOriginalValue || 0).toFixed(2)}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Running Legs */}
                                            {strategyData.legs?.filter(l => !l.exited || ["WAITING_FOR_RECOST", "WAITING_FOR_MNTM", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY"].includes(l.state)).length > 0 && (
                                                <div className="space-y-2">
                                                    <span className="text-xs font-bold uppercase text-muted-foreground">Running Legs</span>
                                                    <div className="space-y-2">
                                                        {strategyData.legs.map((l, idx) => (!l.exited || ["WAITING_FOR_RECOST", "WAITING_FOR_MNTM", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY"].includes(l.state)) && (
                                                            <div key={idx} className="flex items-center justify-between p-3 bg-white border border-border rounded-xl">
                                                                <div className="flex flex-col">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-sm font-bold">{l.instrument?.symbol || "---"} ({l.leg?.side})</span>
                                                                        <span className="px-2 py-0.5 bg-slate-100 text-[10px] font-bold text-slate-600 rounded">
                                                                            {l.leg?.lots} {l.leg?.lots > 1 ? 'Lots' : 'Lot'}
                                                                        </span>
                                                                    </div>
                                                                    <div className="flex items-center gap-2 mt-1 text-xs font-mono text-muted-foreground flex-wrap">
                                                                        <span className="text-primary font-bold">{l.entryTime || "---"}</span>
                                                                        <span>|</span>
                                                                        <span>Entry: {(l.entryPrice || 0).toFixed(2)}</span>
                                                                        <span>|</span>
                                                                        <span className="animate-pulse text-blue-600 font-bold">LTP: {(l.currentLtp || 0).toFixed(2)}</span>
                                                                        {l.slTriggerPrice != null && (
                                                                            <>
                                                                                <span>|</span>
                                                                                <span className="text-red-500 font-bold">SL: {l.slTriggerPrice.toFixed(2)}</span>
                                                                            </>
                                                                        )}
                                                                        {l.rtp != null && (
                                                                            <>
                                                                                <span>|</span>
                                                                                <span className="text-orange-500 font-bold">RTP: {l.rtp.toFixed(2)}</span>
                                                                            </>
                                                                        )}
                                                                        {l.mtp != null && (
                                                                            <>
                                                                                <span>|</span>
                                                                                <span className="text-purple-500 font-bold">MTP: {l.mtp.toFixed(2)}</span>
                                                                            </>
                                                                        )}
                                                                        {l.mntmTargetPrice != null && l.state === "WAITING_FOR_SIMPLE_MNTM" && (
                                                                            <>
                                                                                <span>|</span>
                                                                                <span className="text-blue-500 font-bold animate-pulse">Wait Target: ₹{l.mntmTargetPrice.toFixed(2)}</span>
                                                                            </>
                                                                        )}
                                                                        {l.state === "WAITING_FOR_RECOST" && (
                                                                            <span className="px-2 py-0.5 ml-2 bg-yellow-100 text-yellow-700 font-bold rounded">Waiting Re-Entry (Price)</span>
                                                                        )}
                                                                        {l.state === "WAITING_FOR_RE_ASAP" && (
                                                                            <span className="px-2 py-0.5 ml-2 bg-blue-100 text-blue-700 font-bold rounded">Waiting Re-Entry (ASAP)</span>
                                                                        )}
                                                                        {l.state === "WAITING_FOR_LAZY" && (
                                                                            <span className="px-2 py-0.5 ml-2 bg-purple-100 text-purple-700 font-bold rounded">Initializing Lazy Leg</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="flex items-center gap-4">
                                                                    <div className="flex flex-col items-end">
                                                                        <span className={`text-sm font-mono font-bold ${(l.currentActivePnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                            {(l.currentActivePnlPercent || 0) > 0 ? '+' : ''}{(l.currentActivePnlPercent || 0).toFixed(2)}%
                                                                        </span>
                                                                        <span className={`text-xs font-mono font-bold ${(l.currentActivePnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                            {(l.currentActivePnlRupees || 0) > 0 ? '+' : ''}₹{(l.currentActivePnlRupees || 0).toFixed(2)}
                                                                        </span>
                                                                    </div>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        className="rounded-lg border-orange-500 hover:bg-orange-50 text-orange-600 text-xs font-bold px-3 h-8"
                                                                        onClick={() => handleSquareOffLeg(id, idx)}
                                                                        disabled={l.isExiting}
                                                                    >
                                                                        {l.isExiting ? "Exiting..." :
                                                                            (l.state === "WAITING_FOR_RECOST" || l.state === "WAITING_FOR_MNTM") ? "Cancel Re-Cost" :
                                                                                (l.state === "WAITING_FOR_RE_ASAP") ? "Cancel Re-Entry" :
                                                                                    (l.state === "WAITING_FOR_LAZY") ? "Cancel Lazy Leg" :
                                                                                        "Square Off"}
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Closed Legs */}
                                            {strategyData.legs?.filter(l => l.exited).length > 0 && (
                                                <div className="space-y-2">
                                                    <span className="text-xs font-bold uppercase text-muted-foreground">Closed Legs</span>
                                                    <div className="space-y-2">
                                                        {strategyData.legs.map((l, idx) => l.exited && (
                                                            <div key={idx} className="flex items-center justify-between p-3 bg-muted/50 border border-border/50 rounded-xl opacity-90">
                                                                <div className="flex flex-col w-full">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-sm font-bold text-muted-foreground">{l.instrument?.symbol || "---"} ({l.leg?.side})</span>
                                                                            <span className="px-2 py-0.5 bg-slate-100 text-[10px] font-bold text-slate-400 rounded">
                                                                                {l.leg?.lots} {l.leg?.lots > 1 ? 'Lots' : 'Lot'}
                                                                            </span>
                                                                        </div>
                                                                        <div className="flex items-center gap-3">
                                                                            <span className={`text-sm font-mono font-bold ${(l.pnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                {(l.pnlPercent || 0) > 0 ? '+' : ''}{(l.pnlPercent || 0).toFixed(2)}%
                                                                            </span>
                                                                            <span className={`text-sm font-mono font-bold ${(l.pnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                {(l.pnlRupees || 0) > 0 ? '+' : ''}₹{(l.pnlRupees || 0).toFixed(2)}
                                                                            </span>
                                                                            <span className="px-2 py-0.5 text-[10px] font-bold bg-slate-200 text-slate-500 rounded uppercase">Closed</span>
                                                                        </div>
                                                                    </div>
                                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4 text-[11px] font-mono text-muted-foreground">
                                                                        <div className="flex items-center gap-2 p-1.5 bg-white/50 rounded-md">
                                                                            <span className="text-primary font-bold">ENTRY: {l.entryTime || "---"}</span>
                                                                            <span>@</span>
                                                                            <span className="text-foreground">{(l.entryPrice || 0).toFixed(2)}</span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2 p-1.5 bg-white/50 rounded-md">
                                                                            <span className="text-red-500 font-bold">TRIGGERED SL: {l.exitTime || l.exitSnapshot?.exitTime || "---"}</span>
                                                                            <span>@</span>
                                                                            <span className="text-foreground">{(l.exitSnapshot?.exitLtp || l.currentLtp || 0).toFixed(2)}</span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2 flex-wrap col-span-1 sm:col-span-2">
                                                                            <span className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600">Type: {l.exitType}</span>
                                                                            {l.exitSnapshot?.slTriggerPrice != null && (
                                                                                <span className="px-1.5 py-0.5 bg-red-100 text-red-600 rounded">Initial SL: {l.exitSnapshot.slTriggerPrice.toFixed(2)}</span>
                                                                            )}
                                                                            {l.rtp != null && (
                                                                                <span className="px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded">RTP: {l.rtp.toFixed(2)}</span>
                                                                            )}
                                                                            {l.mtp != null && (
                                                                                <span className="px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded">MTP: {l.mtp.toFixed(2)}</span>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>
                        ))
                }

                {
                    savedStrategies.length > 0 && (
                        <Card className="w-full border-border bg-card mt-8">
                            <CardHeader className="border-b py-4 bg-muted/30 flex flex-col md:flex-row items-center justify-between gap-4">
                                <CardTitle className="text-lg font-bold flex items-center gap-2">
                                    <Save className="h-4 w-4 text-primary" /> Saved Strategies (Templates)
                                </CardTitle>
                                <div className="relative w-full md:w-72">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                    <Input
                                        type="text"
                                        placeholder="Search by strategy name or ID..."
                                        className="h-9 pl-9 pr-4 rounded-xl text-xs bg-white/50 border-none shadow-sm focus-visible:ring-1 focus-visible:ring-primary/20"
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                    />
                                </div>
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
                                            {savedStrategies
                                                .filter(s => (activeTab === 'paper' ? s.config?.is_paper_trading : !s.config?.is_paper_trading))
                                                .filter(s => {
                                                    const name = (s.name || s.config?.name || '').toLowerCase();
                                                    const id = (s.id || '').toLowerCase();
                                                    const search = searchTerm.toLowerCase();
                                                    return name.includes(search) || id.includes(search);
                                                })
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
                                                                {s.config?.legs?.map((l) => `${l.side} ${l.option_type} (${l.lots} ${l.lots > 1 ? 'Lots' : 'Lot'})`).join(' | ') || '---'}
                                                            </span>
                                                        </td>
                                                        <td className="px-4 py-4 text-right">
                                                            <div className="flex items-center justify-end gap-2">
                                                                <Button
                                                                    size="sm"
                                                                    className={`h-8 px-4 gap-1.5 rounded-lg text-xs font-bold shadow-sm ${!isConnected ? 'opacity-50 grayscale cursor-not-allowed' : ''}`}
                                                                    onClick={() => handleExecute(s.id)}
                                                                    disabled={!isConnected}
                                                                    title={!isConnected ? "Please connect to Angel One to execute strategies" : ""}
                                                                >
                                                                    <Play className="h-3.5 w-3.5 fill-current" /> Deploy
                                                                </Button>
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-8 px-4 gap-1.5 rounded-lg text-xs font-bold border-indigo-500 hover:bg-indigo-50 text-indigo-600 shadow-sm"
                                                                    onClick={() => {
                                                                        setViewConfig(s.config);
                                                                        setViewStrategyName(s.name || s.config?.name || 'Strategy');
                                                                        setConfigWindowOpen(true);
                                                                    }}
                                                                >
                                                                    <Settings2 className="h-3.5 w-3.5" /> View
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
                <StrategyLogs
                    isOpen={logWindowOpen}
                    onClose={() => setLogWindowOpen(false)}
                    logs={logStrategyId ? runningStrategies[logStrategyId]?.logs : []}
                    strategyName={logStrategyId ? (runningStrategies[logStrategyId]?.name || runningStrategies[logStrategyId]?.config?.name || 'Strategy') : ''}
                />
                <StrategyConfigModal
                    isOpen={configWindowOpen}
                    onClose={() => setConfigWindowOpen(false)}
                    config={viewConfig}
                    strategyName={viewStrategyName}
                />
            </Tabs>
        </div >
    );
};
