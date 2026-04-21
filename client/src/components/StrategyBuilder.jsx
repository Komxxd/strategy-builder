import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StopCircle, Loader2, TrendingUp, Search, Timer, LayoutDashboard, Target, Save, Play, Plus, Trash2, ShieldCheck, Zap, Copy, MessageSquare, Ghost, X, Settings2, Clock, ChevronDown, ChevronUp, GripVertical, RefreshCw } from 'lucide-react';
import { Switch } from "@/components/ui/switch";
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
    sl_enabled: true,
    stop_loss: 10,
    simple_mntm_enabled: false,
    simple_mntm_mode: 'SIMPLE_PLUS_PCT',
    simple_mntm_value: 0,
    recost_enabled: false,
    recost_mode: 'RECOST_PLUS_PCT',
    recost_value: 0,
    resl_enabled: false,
    resl_mode: 'RESL_PLUS_PCT',
    resl_value: 0,
    rehigh_enabled: false,
    rehigh_mode: 'REHIGH_MINUS_PTS',
    rehigh_value: 0,
    rehigh_mntm_enabled: true,
    rehigh_mntm_mode: 'REHIGH_PLUS_PTS',
    rehigh_mntm_value: 1,
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
    tsl_move: 0,
    tsl_trail: 0
};


const getLegSummary = (leg) => {
    if (!leg) return 'Not configured';
    const strike = leg.strike_criteria === 'CLOSEST_PREMIUM' ? `₹${leg.premium || 0}` : (leg.strike || 'ATM');
    let summary = `${leg.side || 'BUY'} ${leg.option_type || 'CE'} ${strike} (SL ${leg.stop_loss || 0}${leg.sl_type === 'POINTS' ? 'pts' : '%'})`;
    if (leg.tsl_enabled) {
        summary += ` [TSL ${leg.tsl_move || 0}${leg.tsl_type === 'POINTS' ? 'pts' : '%'} | Trl: ${leg.tsl_trail || 0}]`;
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
                            <h3 className="text-base font-medium text-slate-900 tracking-tight">Configure Lazy Leg</h3>
                            <p className="text-[10px] font-medium text-slate-400 uppercase tracking-widest mt-1 opacity-70">
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
                <div className="flex-1 overflow-y-auto p-4 bg-slate-50/30">
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
                <div className="px-6 py-3 bg-white border-t border-slate-100 flex items-center justify-end shrink-0 gap-3">
                    <Button variant="outline" onClick={onClose} className="rounded-xl px-6 font-medium h-12">
                        Cancel
                    </Button>
                    <Button onClick={onClose} className="rounded-xl px-8 font-medium h-12 shadow-lg shadow-primary/20">
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
        <div className={`p-2 rounded-lg border-2 transition-all duration-300 ${isRecursive ? 'bg-muted/30 border-dashed mt-2 ml-4 md:ml-6 border-primary/20' : 'bg-card border-primary/10 hover:border-primary/30 shadow-sm'}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                    <div className={`h-8 w-8 ${isRecursive ? 'bg-orange-500/10 text-orange-600' : 'bg-primary/10 text-primary'} rounded flex items-center justify-center font-medium text-[11px]`}>
                        {legIndex + 1}
                    </div>
                    <div>
                        <h3 className="font-medium text-[11px] tracking-tight">
                            {isRecursive ? `Lazy Leg (Level ${level})` : `Strategy Leg ${legIndex + 1}`}
                        </h3>
                        <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">
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

            <div className="flex flex-wrap items-end gap-x-2 gap-y-2 w-full">
                <div className="space-y-1.5 flex-1 min-w-[100px] sm:min-w-[120px]">
                    <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Option Type
                    </Label>
                    <Select
                        value={leg.option_type}
                        onValueChange={(v) => onChange({ ...leg, option_type: v })}
                    >
                        <SelectTrigger className="h-9 w-full rounded-lg text-[12px]">
                            <SelectValue placeholder="Type" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="CE">Call</SelectItem>
                            <SelectItem value="PE">Put</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1 flex-1 min-w-[140px] sm:min-w-[180px]">
                    <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Strike Criteria
                    </Label>
                    <Select
                        value={leg.strike_criteria || 'STRIKE_TYPE'}
                        onValueChange={(v) => onChange({ ...leg, strike_criteria: v })}
                    >
                        <SelectTrigger className="h-9 w-full rounded-lg text-[11px]">
                            <SelectValue placeholder="Criteria" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="STRIKE_TYPE">Strike Type</SelectItem>
                            <SelectItem value="CLOSEST_PREMIUM">Closest Premium</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {leg.strike_criteria === 'CLOSEST_PREMIUM' ? (
                    <div className="space-y-1 flex-1 min-w-[100px] sm:min-w-[120px]">
                        <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                            Premium (₹)
                        </Label>
                        <Input
                            className="h-9 rounded-lg text-[12px] w-full"
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
                    <div className="space-y-1 flex-1 min-w-[100px]">
                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                            Strike
                        </Label>
                        <Select
                            value={leg.strike}
                            onValueChange={(v) => onChange({ ...leg, strike: v })}
                        >
                            <SelectTrigger className="h-9 w-full rounded-lg text-[11px]">
                                <SelectValue placeholder="Select Strike" />
                            </SelectTrigger>
                            <SelectContent className="max-h-[300px]">
                                {Array.from({ length: 40 }, (_, i) => 40 - i).map(n => (
                                    <SelectItem key={`${idPrefix}-itm-${n}`} value={`ITM${n}`}>ITM {n}</SelectItem>
                                ))}
                                <SelectItem value="ATM">ATM</SelectItem>
                                {Array.from({ length: 40 }, (_, i) => i + 1).map(n => (
                                    <SelectItem key={`${idPrefix}-otm-${n}`} value={`OTM${n}`}>OTM {n}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                <div className="space-y-1 flex-1 min-w-[100px]">
                    <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">Side</Label>
                    <Select
                        value={leg.side}
                        onValueChange={(v) => onChange({ ...leg, side: v })}
                    >
                        <SelectTrigger className="h-9 w-full rounded-lg text-[11px]">
                            <SelectValue placeholder="Side" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="BUY">BUY</SelectItem>
                            <SelectItem value="SELL">SELL</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1 flex-1 min-w-[80px] max-w-[120px]">
                    <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">Lots</Label>
                    <Input
                        className="h-9 w-full rounded-lg text-[11px]"
                        type="number"
                        value={leg.lots}
                        onChange={(e) => onChange({ ...leg, lots: parseInt(e.target.value) })}
                    />
                </div>

                {/* Risk Management Section */}
                <div className="w-full flex flex-col lg:flex-row items-start gap-2 lg:gap-4 pt-2 border-t border-dashed border-gray-100 mt-2">
                    <div className="w-full lg:flex-1 space-y-1.5">
                        <div className="flex items-center justify-between w-full lg:max-w-[280px]">
                            <Label className="text-[10px] font-medium text-gray-700">Stop Loss</Label>
                            <Switch 
                                checked={leg.sl_enabled !== false} 
                                onCheckedChange={(val) => onChange({ ...leg, sl_enabled: val })}
                            />
                        </div>
                        
                        {leg.sl_enabled !== false && (
                            <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
                                <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
                                    <Select
                                        value={leg.sl_type || 'PERCENTAGE'}
                                        onValueChange={(v) => onChange({ ...leg, sl_type: v })}
                                    >
                                        <SelectTrigger className="h-9 w-full rounded-lg text-[11px] bg-background border-input">
                                            <SelectValue placeholder="Type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                            <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
                                    <Input
                                        className="h-9 w-full rounded-lg text-[11px] transition-all focus:ring-emerald-500"
                                        type="number"
                                        value={leg.stop_loss}
                                        onChange={(e) => onChange({ ...leg, stop_loss: parseFloat(e.target.value) })}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="w-full lg:flex-1 space-y-1.5">
                        <div className="flex items-center justify-between w-full lg:max-w-[280px]">
                            <Label className="text-[10px] font-medium text-gray-700">Trailing Stop Loss</Label>
                            <Switch 
                                checked={leg.tsl_enabled || false} 
                                onCheckedChange={(val) => onChange({ ...leg, tsl_enabled: val })}
                            />
                        </div>
                        
                        {leg.tsl_enabled && (
                            <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
                                <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
                                    <Select
                                        value={leg.tsl_type || 'PERCENTAGE'}
                                        onValueChange={(v) => onChange({ ...leg, tsl_type: v })}
                                    >
                                        <SelectTrigger className="h-9 w-full rounded-lg text-[11px] bg-background border-input">
                                            <SelectValue placeholder="Type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                            <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
                                    <Input
                                        className="h-9 w-full rounded-lg text-[11px] focus:ring-emerald-500"
                                        type="number"
                                        placeholder="Move"
                                        value={leg.tsl_move === 0 ? '' : (leg.tsl_move !== undefined ? leg.tsl_move : '')}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            onChange({ ...leg, tsl_move: val === '' ? 0 : parseFloat(val) });
                                        }}
                                    />
                                </div>

                                <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
                                    <Input
                                        className="h-9 w-full rounded-lg text-[11px] focus:ring-emerald-500"
                                        type="number"
                                        placeholder="Trail"
                                        value={leg.tsl_trail === 0 ? '' : (leg.tsl_trail !== undefined ? leg.tsl_trail : '')}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            onChange({ ...leg, tsl_trail: val === '' ? 0 : parseFloat(val) });
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Advanced Execution Management (Momentum & ASAP Re-entry) */}
                <div className="w-full flex flex-col lg:flex-row items-start gap-2 lg:gap-4 pt-2 border-t border-dashed border-gray-100 mt-0">
                    {/* Simple Momentum */}
                    <div className="w-full lg:flex-1 space-y-1.5">
                        <div className="flex items-center justify-between w-full lg:max-w-[280px]">
                            <Label className="text-[10px] font-medium text-gray-700">Simple Momentum</Label>
                            <Switch 
                                checked={leg.simple_mntm_enabled || false} 
                                onCheckedChange={(val) => onChange({ ...leg, simple_mntm_enabled: val })}
                            />
                        </div>
                        
                        {leg.simple_mntm_enabled && (
                            <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
                                <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
                                    <Select
                                        value={leg.simple_mntm_mode || 'SIMPLE_PLUS_PCT'}
                                        onValueChange={(v) => onChange({ ...leg, simple_mntm_mode: v })}
                                    >
                                        <SelectTrigger className="h-9 w-full rounded-lg text-[11px] bg-background border-input">
                                            <SelectValue placeholder="Mode" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="SIMPLE_PLUS_PCT">+ Percentage (%)</SelectItem>
                                            <SelectItem value="SIMPLE_PLUS_PTS">+ Points (Pts)</SelectItem>
                                            <SelectItem value="SIMPLE_MINUS_PCT">- Percentage (%)</SelectItem>
                                            <SelectItem value="SIMPLE_MINUS_PTS">- Points (Pts)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
                                    <Input
                                        className="h-9 w-full rounded-lg text-[11px] transition-all focus:ring-emerald-500"
                                        type="number"
                                        placeholder="Value"
                                        value={leg.simple_mntm_value === 0 ? '' : (leg.simple_mntm_value !== undefined ? leg.simple_mntm_value : '')}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            onChange({ ...leg, simple_mntm_value: val === '' ? 0 : parseFloat(val) });
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* RE-ENTRY */}
                    <div className="w-full lg:flex-1 space-y-1.5">
                        <div className="flex items-center justify-between w-full lg:max-w-[280px]">
                            <Label className="text-[10px] font-medium text-gray-700 uppercase tracking-tight">RE-Entry</Label>
                            <Switch 
                                checked={leg.re_asap_enabled || leg.recost_enabled || leg.resl_enabled || leg.rehigh_enabled || leg.relow_enabled || leg.lazy_leg_enabled || false} 
                                onCheckedChange={(val) => {
                                    if (val) {
                                        onChange({
                                            ...leg,
                                            re_asap_enabled: true,
                                            recost_enabled: false,
                                            resl_enabled: false,
                                            rehigh_enabled: false,
                                            lazy_leg_enabled: false,
                                            re_asap_max_entries: leg.re_asap_max_entries || 1
                                        });
                                    } else {
                                        onChange({
                                            ...leg,
                                            re_asap_enabled: false,
                                            recost_enabled: false,
                                            resl_enabled: false,
                                            rehigh_enabled: false,
                                            relow_enabled: false,
                                            lazy_leg_enabled: false
                                        });
                                    }
                                }}
                            />
                        </div>

                        {(leg.re_asap_enabled || leg.recost_enabled || leg.resl_enabled || leg.rehigh_enabled || leg.relow_enabled || leg.lazy_leg_enabled) && (
                            <div className="animate-in fade-in slide-in-from-top-1">
                                <div className="w-full max-w-[180px]">
                                    <Select
                                        value={leg.lazy_leg_enabled ? 'LAZY_LEG' : (leg.recost_enabled ? 'RE_COST' : (leg.resl_enabled ? 'RE_SL' : (leg.rehigh_enabled ? 'RE_HIGH' : (leg.relow_enabled ? 'RE_LOW' : 'RE_ASAP'))))}
                                        onValueChange={(v) => {
                                            const isReHigh = v === 'RE_HIGH';
                                            const isReLow = v === 'RE_LOW';
                                            onChange({
                                                ...leg,
                                                re_asap_enabled: v === 'RE_ASAP',
                                                recost_enabled: v === 'RE_COST',
                                                resl_enabled: v === 'RE_SL',
                                                rehigh_enabled: isReHigh,
                                                relow_enabled: isReLow,
                                                lazy_leg_enabled: v === 'LAZY_LEG',
                                                lazy_leg: v === 'LAZY_LEG' ? (leg.lazy_leg || { ...DEFAULT_LEG }) : leg.lazy_leg,
                                                // Specifics for RE HIGH
                                                rehigh_mode: isReHigh ? 'REHIGH_MINUS_PTS' : (leg.rehigh_mode || 'REHIGH_MINUS_PTS'),
                                                rehigh_value: isReHigh ? 0 : (leg.rehigh_value || 0),
                                                rehigh_mntm_enabled: isReHigh ? true : leg.rehigh_mntm_enabled,
                                                rehigh_mntm_mode: isReHigh ? 'REHIGH_PLUS_PTS' : (leg.rehigh_mntm_mode || 'REHIGH_PLUS_PTS'),
                                                rehigh_mntm_value: isReHigh ? 1 : (leg.rehigh_mntm_value || 1),
                                                // Specifics for RE LOW
                                                relow_mode: isReLow ? 'RELOW_PLUS_PTS' : (leg.relow_mode || 'RELOW_PLUS_PTS'),
                                                relow_value: isReLow ? 0 : (leg.relow_value || 0),
                                                relow_mntm_enabled: isReLow ? true : leg.relow_mntm_enabled,
                                                relow_mntm_mode: isReLow ? 'RELOW_PLUS_PTS' : (leg.relow_mntm_mode || 'RELOW_PLUS_PTS'),
                                                relow_mntm_value: isReLow ? 1 : (leg.relow_mntm_value || 1)
                                            });
                                        }}
                                    >
                                        <SelectTrigger className="h-9 w-full rounded-lg text-[12px] bg-background border-input">
                                            <SelectValue placeholder="Type" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="RE_ASAP">RE ASAP</SelectItem>
                                            <SelectItem value="RE_COST">RE COST</SelectItem>
                                            <SelectItem value="RE_SL">RE SL</SelectItem>
                                            <SelectItem value="RE_HIGH">RE HIGH</SelectItem>
                                            <SelectItem value="RE_LOW">RE LOW</SelectItem>
                                            <SelectItem value="LAZY_LEG">LAZY LEG</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Re-Entry Configurations */}
                {(leg.re_asap_enabled || leg.recost_enabled || leg.resl_enabled || leg.rehigh_enabled || leg.relow_enabled || leg.lazy_leg_enabled) && (
                    <div className="w-full pt-2 border-t border-dashed border-gray-100 mt-2 animate-in fade-in slide-in-from-top-2">
                        {leg.re_asap_enabled && (
                            <div className="space-y-1.5">
                                <div className="w-full max-w-[150px]">
                                    <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Max Entries</Label>
                                    <Select
                                        value={(leg.re_asap_max_entries || 1).toString()}
                                        onValueChange={(v) => onChange({ ...leg, re_asap_max_entries: parseInt(v) })}
                                    >
                                        <SelectTrigger className="h-9 w-full rounded-lg text-[12px] bg-background border-input">
                                            <SelectValue placeholder="Max Entries" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                <SelectItem key={`${idPrefix}-max-re-asap-${num}`} value={num.toString()}>
                                                    {num}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}

                        {leg.recost_enabled && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Re-Cost Mode</Label>
                                        <Select
                                            value={leg.recost_mode || 'RECOST_PLUS_PCT'}
                                            onValueChange={(v) => onChange({ ...leg, recost_mode: v })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[10px]">
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
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1">
                                            Value {leg.recost_mode && leg.recost_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                        </Label>
                                        <Input
                                            className="h-9 rounded-lg text-[9px]"
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
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Max Entries</Label>
                                        <Select
                                            value={(leg.max_reentry || 1).toString()}
                                            onValueChange={(v) => onChange({ ...leg, max_reentry: parseInt(v) })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[9px]">
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

                                <div className="space-y-2 pt-1">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`reentry-mntm-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.recost_mntm_enabled || false}
                                            onChange={(e) => onChange({ ...leg, recost_mntm_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`reentry-mntm-${idPrefix}`} className="text-[10px] cursor-pointer">Re-Entry Momentum</Label>
                                    </div>

                                    {leg.recost_mntm_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Mntm Mode</Label>
                                                <Select
                                                    value={leg.recost_mntm_mode || 'RECOST_PLUS_PCT'}
                                                    onValueChange={(v) => onChange({ ...leg, recost_mntm_mode: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
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
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">
                                                    Value {leg.recost_mntm_mode && leg.recost_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
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
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.reentry_sl_enabled || false}
                                            onChange={(e) => onChange({ ...leg, reentry_sl_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`reentry-sl-${idPrefix}`} className="text-[10px] font-medium tracking-wide text-foreground cursor-pointer uppercase">
                                            Override SL on Re-Entry
                                        </Label>
                                    </div>
                                    {leg.reentry_sl_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">SL Type</Label>
                                                <Select
                                                    value={leg.reentry_sl_type || 'PERCENTAGE'}
                                                    onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="SL Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                                        <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2 mb-2">
                                                    Value {leg.reentry_sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
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

                        {leg.resl_enabled && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">RE SL Mode</Label>
                                        <Select
                                            value={leg.resl_mode || 'RESL_PLUS_PCT'}
                                            onValueChange={(v) => onChange({ ...leg, resl_mode: v })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                <SelectValue placeholder="Mode" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="RESL_PLUS_PCT">RE-SL + %</SelectItem>
                                                <SelectItem value="RESL_PLUS_PTS">RE-SL + Pts</SelectItem>
                                                <SelectItem value="RESL_MINUS_PCT">RE-SL - %</SelectItem>
                                                <SelectItem value="RESL_MINUS_PTS">RE-SL - Pts</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1">
                                            Value {leg.resl_mode && leg.resl_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                        </Label>
                                        <Input
                                            className="h-9 rounded-lg text-[9px]"
                                            type="text"
                                            value={leg.resl_value === undefined ? '' : leg.resl_value}
                                            onChange={(e) => {
                                                const val = e.target.value;
                                                if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                    onChange({ ...leg, resl_value: val });
                                                }
                                            }}
                                            onBlur={(e) => onChange({ ...leg, resl_value: parseFloat(e.target.value) || 0 })}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Max Entries</Label>
                                        <Select
                                            value={(leg.max_reentry || 1).toString()}
                                            onValueChange={(v) => onChange({ ...leg, max_reentry: parseInt(v) })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[9px]">
                                                <SelectValue placeholder="Entries" />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-[250px]">
                                                {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                    <SelectItem key={`${idPrefix}-max-resl-${num}`} value={num.toString()}>
                                                        {num} {num === 1 ? 'Entry' : 'Entries'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="space-y-2 pt-1">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`resl-mntm-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.resl_mntm_enabled || false}
                                            onChange={(e) => onChange({ ...leg, resl_mntm_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`resl-mntm-${idPrefix}`} className="text-[10px] cursor-pointer">Re-Entry Momentum</Label>
                                    </div>

                                    {leg.resl_mntm_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Mntm Mode</Label>
                                                <Select
                                                    value={leg.resl_mntm_mode || 'RESL_PLUS_PCT'}
                                                    onValueChange={(v) => onChange({ ...leg, resl_mntm_mode: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="Mode" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="RESL_PLUS_PCT">RTP + %</SelectItem>
                                                        <SelectItem value="RESL_PLUS_PTS">RTP + Pts</SelectItem>
                                                        <SelectItem value="RESL_MINUS_PCT">RTP - %</SelectItem>
                                                        <SelectItem value="RESL_MINUS_PTS">RTP - Pts</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">
                                                    Value {leg.resl_mntm_mode && leg.resl_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
                                                    type="text"
                                                    value={leg.resl_mntm_value === undefined ? '' : leg.resl_mntm_value}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        if (val === '' || /^\d*\.?\d*$/.test(val)) {
                                                            onChange({ ...leg, resl_mntm_value: val });
                                                        }
                                                    }}
                                                    onBlur={(e) => onChange({ ...leg, resl_mntm_value: parseFloat(e.target.value) || 0 })}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`reentry-sl-sl-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.reentry_sl_enabled || false}
                                            onChange={(e) => onChange({ ...leg, reentry_sl_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`reentry-sl-sl-${idPrefix}`} className="text-[10px] font-medium tracking-wide text-foreground cursor-pointer uppercase">
                                            Override SL on Re-Entry
                                        </Label>
                                    </div>
                                    {leg.reentry_sl_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">SL Type</Label>
                                                <Select
                                                    value={leg.reentry_sl_type || 'PERCENTAGE'}
                                                    onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="SL Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                                        <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2 mb-2">
                                                    Value {leg.reentry_sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
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


                        {leg.rehigh_enabled && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">RE HIGH Mode</Label>
                                        <Select
                                            value={leg.rehigh_mode || 'REHIGH_MINUS_PTS'}
                                            onValueChange={(v) => onChange({ ...leg, rehigh_mode: v })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                <SelectValue placeholder="Mode" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="REHIGH_MINUS_PCT">High - %</SelectItem>
                                                <SelectItem value="REHIGH_MINUS_PTS">High - Pts</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1">Value</Label>
                                        <Input
                                            className="h-9 rounded-lg text-[9px]"
                                            type="number"
                                            value={leg.rehigh_value === undefined || leg.rehigh_value === '' ? '' : leg.rehigh_value}
                                            onChange={(e) => onChange({ ...leg, rehigh_value: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                                            onBlur={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (isNaN(val) || val < 1) {
                                                    onChange({ ...leg, rehigh_value: 1 });
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Max Entries</Label>
                                        <Select
                                            value={(leg.max_reentry || 1).toString()}
                                            onValueChange={(v) => onChange({ ...leg, max_reentry: parseInt(v) })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[9px]">
                                                <SelectValue placeholder="Entries" />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-[250px]">
                                                {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                    <SelectItem key={`${idPrefix}-max-rehigh-${num}`} value={num.toString()}>
                                                        {num} {num === 1 ? 'Entry' : 'Entries'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="space-y-2 pt-1">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`rehigh-mntm-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.rehigh_mntm_enabled || false}
                                            onChange={(e) => onChange({ ...leg, rehigh_mntm_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`rehigh-mntm-${idPrefix}`} className="text-[10px] cursor-pointer">Re-Entry Momentum</Label>
                                    </div>

                                    {leg.rehigh_mntm_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Mntm Mode</Label>
                                                <Select
                                                    value={leg.rehigh_mntm_mode || 'REHIGH_PLUS_PCT'}
                                                    onValueChange={(v) => onChange({ ...leg, rehigh_mntm_mode: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="Mode" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="REHIGH_PLUS_PCT">RTP + %</SelectItem>
                                                        <SelectItem value="REHIGH_PLUS_PTS">RTP + Pts</SelectItem>
                                                        <SelectItem value="REHIGH_MINUS_PCT">RTP - %</SelectItem>
                                                        <SelectItem value="REHIGH_MINUS_PTS">RTP - Pts</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">
                                                    Value {leg.rehigh_mntm_mode && leg.rehigh_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
                                                    type="number"
                                                    value={leg.rehigh_mntm_value === undefined ? '' : leg.rehigh_mntm_value}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        // Prevent values <= 0
                                                        if (!isNaN(val) && val > 0) {
                                                            onChange({ ...leg, rehigh_mntm_value: val });
                                                        } else if (e.target.value === '') {
                                                            onChange({ ...leg, rehigh_mntm_value: '' });
                                                        }
                                                    }}
                                                    onBlur={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        if (isNaN(val) || val <= 0) {
                                                            onChange({ ...leg, rehigh_mntm_value: 1 });
                                                        }
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`reentry-rehigh-sl-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.reentry_sl_enabled || false}
                                            onChange={(e) => onChange({ ...leg, reentry_sl_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`reentry-rehigh-sl-${idPrefix}`} className="text-[10px] font-medium tracking-wide text-foreground cursor-pointer uppercase">
                                            Override SL on Re-Entry
                                        </Label>
                                    </div>
                                    {leg.reentry_sl_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">SL Type</Label>
                                                <Select
                                                    value={leg.reentry_sl_type || 'PERCENTAGE'}
                                                    onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="SL Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                                        <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2 mb-2">
                                                    Value {leg.reentry_sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
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

                        {leg.relow_enabled && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">RE LOW Mode</Label>
                                        <Select
                                            value={leg.relow_mode || 'RELOW_PLUS_PTS'}
                                            onValueChange={(v) => onChange({ ...leg, relow_mode: v })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                <SelectValue placeholder="Mode" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="RELOW_PLUS_PCT">Low + %</SelectItem>
                                                <SelectItem value="RELOW_PLUS_PTS">Low + Pts</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1">Value</Label>
                                        <Input
                                            className="h-9 rounded-lg text-[9px]"
                                            type="number"
                                            value={leg.relow_value === undefined || leg.relow_value === '' ? '' : leg.relow_value}
                                            onChange={(e) => onChange({ ...leg, relow_value: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                                            onBlur={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (isNaN(val) || val < 1) {
                                                    onChange({ ...leg, relow_value: 1 });
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">Max Entries</Label>
                                        <Select
                                            value={(leg.max_reentry || 1).toString()}
                                            onValueChange={(v) => onChange({ ...leg, max_reentry: parseInt(v) })}
                                        >
                                            <SelectTrigger className="h-9 rounded-lg text-[9px]">
                                                <SelectValue placeholder="Entries" />
                                            </SelectTrigger>
                                            <SelectContent className="max-h-[250px]">
                                                {Array.from({ length: 20 }, (_, i) => i + 1).map(num => (
                                                    <SelectItem key={`${idPrefix}-max-relow-${num}`} value={num.toString()}>
                                                        {num} {num === 1 ? 'Entry' : 'Entries'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="space-y-2 pt-1">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`relow-mntm-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.relow_mntm_enabled || false}
                                            onChange={(e) => onChange({ ...leg, relow_mntm_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`relow-mntm-${idPrefix}`} className="text-[10px] cursor-pointer">Re-Entry Momentum</Label>
                                    </div>

                                    {leg.relow_mntm_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Mntm Mode</Label>
                                                <Select
                                                    value={leg.relow_mntm_mode || 'RELOW_PLUS_PCT'}
                                                    onValueChange={(v) => onChange({ ...leg, relow_mntm_mode: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="Mode" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="RELOW_PLUS_PCT">RTP + %</SelectItem>
                                                        <SelectItem value="RELOW_PLUS_PTS">RTP + Pts</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">
                                                    Value {leg.relow_mntm_mode && leg.relow_mntm_mode.includes('PCT') ? '(%)' : '(Pts)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
                                                    type="number"
                                                    value={leg.relow_mntm_value === undefined ? '' : leg.relow_mntm_value}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        if (!isNaN(val) && val > 0) {
                                                            onChange({ ...leg, relow_mntm_value: val });
                                                        } else if (e.target.value === '') {
                                                            onChange({ ...leg, relow_mntm_value: '' });
                                                        }
                                                    }}
                                                    onBlur={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        if (isNaN(val) || val <= 0) {
                                                            onChange({ ...leg, relow_mntm_value: 1 });
                                                        }
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id={`reentry-relow-sl-${idPrefix}`}
                                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            checked={leg.reentry_sl_enabled || false}
                                            onChange={(e) => onChange({ ...leg, reentry_sl_enabled: e.target.checked })}
                                        />
                                        <Label htmlFor={`reentry-relow-sl-${idPrefix}`} className="text-[10px] font-medium tracking-wide text-foreground cursor-pointer uppercase">
                                            Override SL on Re-Entry
                                        </Label>
                                    </div>
                                    {leg.reentry_sl_enabled && (
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">SL Type</Label>
                                                <Select
                                                    value={leg.reentry_sl_type || 'PERCENTAGE'}
                                                    onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
                                                >
                                                    <SelectTrigger className="h-9 rounded-lg text-[10px]">
                                                        <SelectValue placeholder="SL Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                                        <SelectItem value="POINTS">Points (Pts)</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2 mb-2">
                                                    Value {leg.reentry_sl_type === 'POINTS' ? '(Pts)' : '(%)'}
                                                </Label>
                                                <Input
                                                    className="h-9 rounded-lg text-[10px]"
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

                        {leg.lazy_leg_enabled && leg.lazy_leg && (
                            <div className="animate-in slide-in-from-top-2">
                                <div className="flex items-center justify-between p-2.5 bg-orange-50/50 border border-orange-200 rounded-lg group hover:border-orange-300 transition-all cursor-pointer" onClick={() => setIsLazyModalOpen(true)}>
                                    <div className="flex items-center gap-2">
                                        <div className="h-8 w-8 bg-orange-500/10 text-orange-600 rounded flex items-center justify-center font-bold text-[11px]">
                                            L
                                        </div>
                                        <div>
                                            <p className="text-[9px] font-black text-orange-600 uppercase tracking-widest">Lazy Leg Lvl {level + 1}</p>
                                            <p className="text-[10px] font-medium text-slate-700">{getLegSummary(leg.lazy_leg)}</p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="sm" className="h-7 rounded-md text-[10px] group-hover:bg-orange-100/50">
                                        <Settings2 className="h-3.5 w-3.5 mr-1" /> Config
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
                )}
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
        <div className="flex items-center gap-1 px-1.5 py-0.5 ml-1 bg-indigo-50 text-indigo-700 font-medium rounded border border-indigo-100/60 shadow-sm animate-pulse">
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
            <div className="flex flex-wrap items-end justify-between gap-2.5 px-0 w-full">
                <div className="space-y-1 w-full md:max-w-sm flex-1 min-w-[200px]">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Strategy Name
                    </Label>
                    <Input
                        className="h-9 rounded-lg text-[11px]"
                        type="text"
                        placeholder="E.g., Morning Breakout (CE)"
                        value={config.name || ''}
                        onChange={(e) => setConfig({ ...config, name: e.target.value })}
                    />
                </div>
                <div className="space-y-1 w-full min-w-[120px] md:w-[150px] flex-1 md:flex-none">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Index
                    </Label>
                    <Select value={config.index} onValueChange={(v) => setConfig({ ...config, index: v })}>
                        <SelectTrigger className="h-9 rounded-lg text-[11px]">
                            <SelectValue placeholder="Select Index" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="NIFTY">NIFTY</SelectItem>
                            <SelectItem value="SENSEX">SENSEX</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="space-y-1 w-full min-w-[180px] md:w-[220px] flex-1 md:flex-none">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        Limit Offset
                    </Label>
                    <div className="flex items-center gap-2">
                        <div className="w-[75px] shrink-0">
                            <Select value={config.entry_limit_offset_type || 'POINTS'} onValueChange={(v) => setConfig({ ...config, entry_limit_offset_type: v })}>
                                <SelectTrigger className="h-9 rounded-lg text-[10px] bg-background border-input">
                                    <SelectValue placeholder="Type" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="POINTS">Pts</SelectItem>
                                    <SelectItem value="PERCENTAGE">%</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex-1">
                            <Input
                                className="h-9 rounded-lg text-[11px]"
                                type="text"
                                placeholder="0.0"
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
                    </div>
                </div>
                <div className="space-y-1 w-full min-w-[120px] md:w-[150px] flex-none">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Chase Time (s)
                    </Label>
                    <Input
                        className="h-9 rounded-lg text-[11px]"
                        type="number"
                        placeholder="45"
                        value={config.chase_time_seconds}
                        onChange={(e) => setConfig({ ...config, chase_time_seconds: parseInt(e.target.value) || 0 })}
                    />
                </div>
                <div className="space-y-1 w-full min-w-[120px] md:w-[150px] flex-none">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Entry Time
                    </Label>
                    <Input
                        className="h-9 rounded-lg text-[11px]"
                        type="time"
                        step="1"
                        value={config.entry_time}
                        onChange={(e) => setConfig({ ...config, entry_time: e.target.value })}
                    />
                </div>
                <div className="space-y-1 w-full min-w-[120px] md:w-[150px] flex-none">
                    <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground flex items-center">
                        Exit Time
                    </Label>
                    <Input
                        className="h-9 rounded-lg text-[11px]"
                        type="time"
                        step="1"
                        value={config.exit_time}
                        onChange={(e) => setConfig({ ...config, exit_time: e.target.value })}
                    />
                </div>
            </div>

            <div className="flex flex-wrap items-start gap-4 md:gap-5 px-0 w-full pt-2 border-t border-gray-50 mt-2 mb-1">
                {/* Overall Stop Loss */}
                <div className="space-y-1.5 w-full md:w-auto md:min-w-[280px]">
                    <div className="flex items-center justify-between">
                        <Label className="text-[10px] font-medium text-gray-700">Overall Stop Loss</Label>
                        <Switch
                            checked={config.overall_sl_enabled}
                            onCheckedChange={(val) => setConfig({ ...config, overall_sl_enabled: val })}
                        />
                    </div>
                    {config.overall_sl_enabled && (
                        <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
                            <div className="flex flex-col gap-0.5 flex-1">
                                <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Type</Label>
                                <Select value={config.overall_sl_type || 'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_sl_type: v })}>
                                    <SelectTrigger className="h-9 w-full sm:w-44 rounded-lg text-[11px] bg-background border-input">
                                        <SelectValue placeholder="Type" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                        <SelectItem value="AMOUNT">Amount (₹)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex flex-col gap-0.5 w-24 sm:w-28 shrink-0">
                                <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Value</Label>
                                <Input
                                    className="h-9 w-full rounded-lg text-[11px] border-input bg-background focus:ring-emerald-500 focus:border-emerald-500"
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
                        </div>
                    )}
                </div>

                {/* Overall Target */}
                <div className="space-y-1.5 w-full md:w-auto md:min-w-[280px]">
                    <div className="flex items-center justify-between">
                        <Label className="text-[10px] font-medium text-gray-700">Overall Target</Label>
                        <Switch
                            checked={config.overall_target_enabled}
                            onCheckedChange={(val) => setConfig({ ...config, overall_target_enabled: val })}
                        />
                    </div>
                    {config.overall_target_enabled && (
                        <div className="flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
                            <div className="flex flex-col gap-0.5 flex-1">
                                <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Type</Label>
                                <Select value={config.overall_target_type || 'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_target_type: v })}>
                                    <SelectTrigger className="h-9 w-full sm:w-44 rounded-lg text-[11px] bg-background border-input">
                                        <SelectValue placeholder="Type" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                                        <SelectItem value="AMOUNT">Amount (₹)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex flex-col gap-0.5 w-24 sm:w-28 shrink-0">
                                <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Value</Label>
                                <Input
                                    className="h-9 w-full rounded-lg text-[11px] border-input bg-background focus:ring-emerald-500 focus:border-emerald-500"
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
                        </div>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-between pt-2 hide-on-readonly">
                <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    Strategy Legs
                </div>
                <Button
                    type="button"
                    variant="outline"
                    className="h-8 gap-2 rounded-lg text-[10px]"
                    onClick={() => {
                        const next = [...config.legs, { ...DEFAULT_LEG }];
                        setConfig({ ...config, legs: next });
                    }}
                >
                    <Plus className="h-3 w-3" /> Add Leg
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
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

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">


                {config.ordertype !== 'LIMIT' && (config.ordertype !== 'MARKET' && config.ordertype !== 'STOPLOSS_MARKET' && (
                    <div className="space-y-1">
                        <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Price</Label>
                        <Input
                            className="h-9 rounded-lg text-[12px]"
                            type="number"
                            step="0.05"
                            value={config.price}
                            onChange={(e) => setConfig({ ...config, price: e.target.value })}
                        />
                    </div>
                ))}

                {(config.ordertype === 'STOPLOSS_LIMIT' || config.ordertype === 'STOPLOSS_MARKET') && (
                    <div className="space-y-1">
                        <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Trigger Price</Label>
                        <Input
                            className="h-9 rounded-lg text-[12px]"
                            type="number"
                            step="0.05"
                            value={config.triggerprice}
                            onChange={(e) => setConfig({ ...config, triggerprice: e.target.value })}
                        />
                    </div>
                )}

                <div className="flex items-end hide-on-readonly">
                    <Button
                        className="w-full h-9 gap-2 rounded-lg shadow-md font-medium text-[10px]"
                        onClick={handleSave}
                        disabled={loading}
                    >
                        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        {editingId ? "Update Strategy" : "Save Strategy"}
                    </Button>
                </div>
                {editingId && (
                    <div className="flex items-end hide-on-readonly">
                        <Button
                            variant="outline"
                            className="w-full h-9 gap-2 rounded-lg text-[10px]"
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
    const [isConfigExpanded, setIsConfigExpanded] = useState(false);
    const [collapsedSections, setCollapsedSections] = useState({ 'saved-strategies': true });

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
        overall_sl_enabled: false,
        overall_target_type: 'PERCENTAGE',
        overall_target_value: 0,
        overall_target_enabled: false,
        entry_limit_offset: 0,
        entry_limit_offset_type: 'POINTS',
        chase_time_seconds: 45,
        legs: [
            { strike_criteria: 'STRIKE_TYPE', option_type: 'CE', strike: 'ATM', premium: 0, side: 'BUY', lots: 1, sl_type: 'PERCENTAGE', stop_loss: 10, simple_mntm_enabled: false, simple_mntm_mode: 'SIMPLE_PLUS_PCT', simple_mntm_value: 0, recost_enabled: false, recost_mode: 'RECOST_PLUS_PCT', recost_value: 0, max_reentry: 1, reentry_sl_enabled: false, reentry_sl_type: 'PERCENTAGE', reentry_sl_value: 10, re_asap_enabled: false, re_asap_max_entries: 1, lazy_leg_enabled: false, lazy_leg: null, tsl_enabled: false, tsl_type: 'PERCENTAGE', tsl_move: 0 }
        ]
    });

    const fetchSavedStrategies = async () => {
        try {
            const res = await axios.get(`${API_BASE_URL}/strategy/user`);
            let fetchedData = res.data?.data || [];

            // Client-side ordering
            const savedOrder = JSON.parse(localStorage.getItem('custom_strategy_order') || '[]');
            if (savedOrder.length > 0) {
                fetchedData.sort((a, b) => {
                    const indexA = savedOrder.indexOf(a.id);
                    const indexB = savedOrder.indexOf(b.id);
                    if (indexA === -1 && indexB === -1) return 0;
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;
                    return indexA - indexB;
                });
            }

            setSavedStrategies(fetchedData);
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
        // Prevent duplicate strategy names
        if (config.name) {
            const isDuplicate = savedStrategies.find(s =>
                s.name.trim().toLowerCase() === config.name.trim().toLowerCase() &&
                s.id !== editingId
            );
            if (isDuplicate) {
                alert(`A strategy named "${config.name}" already exists. Please choose a different name.`);
                return;
            }
        }

        setLoading(true);
        const finalConfig = {
            ...config,
            variety: 'STOPLOSS',
            producttype: 'CARRYFORWARD',
            ordertype: 'LIMIT',
            duration: 'DAY'
        };
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
            const res = await axios.post(`${API_BASE_URL}/strategy/execute/${id}`, { is_paper_trading: activeTab === 'paper' });
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

    const handleResume = async (id) => {
        if (!id) return;
        if (!confirm("Resume this PAUSED strategy? Monitoring will restart.")) return;
        try {
            await axios.post(`${API_BASE_URL}/strategy/resume/${id}`);
            fetchActive();
        } catch (err) {
            alert("Error resuming strategy: " + (err.response?.data?.message || err.message));
        }
    };

    const handleEdit = (strategy) => {
        const conf = strategy.config;
        setConfig({
            ...conf,
            variety: 'STOPLOSS',
            producttype: 'CARRYFORWARD',
            ordertype: 'LIMIT',
            duration: 'DAY',
            overall_sl_enabled: conf.overall_sl_enabled || (conf.overall_sl_value > 0),
            overall_target_enabled: conf.overall_target_enabled || (conf.overall_target_value > 0)
        });
        setEditingId(strategy.id);
        setIsConfigExpanded(true);
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
        <div className="space-y-4">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">

                <Card className="w-full border-border bg-card overflow-hidden">
                    <CardHeader
                        className="border-b bg-muted py-2 px-3 cursor-pointer hover:bg-muted/80 transition-colors"
                        onClick={() => setIsConfigExpanded(!isConfigExpanded)}
                    >
                        <div className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2 text-[11px] font-medium">
                                <Target className="h-4 w-4 text-primary" />
                                Strategy Configuration
                            </CardTitle>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0">
                                {isConfigExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                        </div>
                    </CardHeader>
                    {isConfigExpanded && (
                        <CardContent className="p-2 animate-in slide-in-from-top-2 duration-200">
                            <StrategyFormContent config={config} setConfig={setConfig} editingId={editingId} setEditingId={setEditingId} loading={loading} handleSave={handleSave} isReadOnly={false} />
                        </CardContent >
                    )}
                </Card >

                {
                    Object.entries(runningStrategies).length > 0 && (
                        <div className="mt-6">
                            <Card className="w-full border-border bg-card mb-4 overflow-hidden">
                                <div
                                    className="border-b bg-muted/60 py-3 px-4 flex items-center justify-between cursor-pointer hover:bg-muted/80 transition-colors"
                                    onClick={() => setCollapsedSections(prev => ({ ...prev, 'active-strategies': !prev['active-strategies'] }))}
                                >
                                    <CardTitle className="flex items-center gap-2 text-[11px] font-medium">
                                        <Play className="h-4 w-4 text-primary" /> Active Executions
                                    </CardTitle>
                                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
                                        {collapsedSections['active-strategies'] ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </Card>
                            {!collapsedSections['active-strategies'] && (
                                <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                                    {Object.entries(runningStrategies)
                                        .filter(([_, strategyData]) => {
                                            const isPaper = !!strategyData.config?.is_paper_trading;
                                            return activeTab === 'paper' ? isPaper : !isPaper;
                                        })
                                        .map(([id, strategyData]) => (
                                            <Card key={id} className={`w-full border-border animate-in fade-in slide-in-from-bottom-4 duration-500 shadow-sm ${strategyData.config?.is_paper_trading ? 'bg-blue-50/50' : 'bg-orange-50/50'}`}>
                                                <CardContent className="p-3 space-y-2">
                                                     <div 
                                                         className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 cursor-pointer hover:bg-black/5 rounded-xl p-2 -m-2 transition-colors relative group"
                                                         onClick={() => setCollapsedSections(prev => ({ ...prev, [id]: prev[id] === true ? false : true }))}
                                                     >
                                                         <div className="flex items-center gap-x-2.5 gap-y-1.5 flex-wrap flex-1">
                                                             <div className="flex items-center gap-2">
                                                                 <div className="h-6 w-6 flex items-center justify-center -ml-1">
                                                                     {collapsedSections[id] === true ? <ChevronUp className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors" /> : <ChevronDown className="h-4 w-4 text-slate-400 group-hover:text-primary transition-colors" />}
                                                                 </div>
                                                             </div>
                                                            <span className="relative flex h-2 w-2 shadow-[0_0_10px_rgba(34,197,94,0.3)] rounded-full mr-1">
                                                                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${strategyData.status === 'FAILED' ? 'bg-red-400' : strategyData.status === 'PAUSED' ? 'bg-amber-400' : 'bg-green-400'} opacity-75`}></span>
                                                                <span className={`relative inline-flex rounded-full h-2 w-2 ${strategyData.status === 'FAILED' ? 'bg-red-500' : strategyData.status === 'PAUSED' ? 'bg-amber-500' : 'bg-green-500'}`}></span>
                                                            </span>

                                                            <span className="text-xs font-bold text-black">
                                                                {strategyData.name || strategyData.config?.name || 'Strategy Execution'}
                                                                <span className="text-[10px] font-mono text-black/60 ml-1.5">#{id.split('-')[0] || id}</span>
                                                            </span>

                                                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm uppercase ${strategyData.config?.is_paper_trading ? 'bg-blue-100/80 text-blue-700 border border-blue-200' : 'bg-orange-100/80 text-orange-700 border border-orange-200'}`}>
                                                                {strategyData.status} • {strategyData.config?.is_paper_trading ? 'PAPER' : 'LIVE'} • {strategyData.config?.index}
                                                            </span>

                                                            {strategyData.config?.exit_time && (
                                                                <span className="text-[9px] font-black px-1.5 py-0.5 rounded shadow-sm uppercase bg-slate-100/80 text-slate-700 border border-slate-200 flex items-center gap-1">
                                                                    <Clock className="h-2.5 w-2.5" /> Exit: {strategyData.config.exit_time}
                                                                </span>
                                                            )}

                                                            {strategyData.status === 'WAITING' && strategyData.config?.entry_time && (
                                                                <EntryTimer entryTime={strategyData.config.entry_time} />
                                                            )}

                                                            {(strategyData?.status === "IN_POSITION" || strategyData?.status === "COMPLETED") && (
                                                                <div className="flex items-center gap-1.5 ml-1">
                                                                    <span className={`text-[11px] font-mono font-medium px-1.5 py-0.5 rounded border shadow-sm ${(strategyData.pnlPercent || 0) >= 0
                                                                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                                                        : 'bg-red-50 text-red-700 border-red-200'
                                                                        }`}>
                                                                        PnL: {(strategyData.pnlPercent || 0) > 0 ? '+' : ''}{(strategyData.pnlPercent || 0).toFixed(2)}% | {(strategyData.totalPnlRupees || 0) > 0 ? '+' : ''}₹{(strategyData.totalPnlRupees || 0).toFixed(0)}
                                                                    </span>
                                                                    <span className="text-[10px] font-mono font-bold text-black bg-slate-50 border border-slate-200 px-1.5 py-0.5 shadow-sm rounded">
                                                                        Trade Value: ₹{(strategyData.totalOriginalValue || 0).toFixed(0)}
                                                                    </span>
                                                                    {strategyData.config?.overall_sl_enabled && strategyData.totalOriginalValue > 0 && (
                                                                        <span className="text-[10px] font-mono font-medium text-red-500 bg-red-50 border border-red-100 px-1.5 py-0.5 shadow-sm rounded">
                                                                            SL: -₹{(() => {
                                                                                const total = strategyData.totalOriginalValue;
                                                                                const val = strategyData.config.overall_sl_value || 0;
                                                                                const amt = (strategyData.config.overall_sl_type === 'PERCENTAGE' 
                                                                                    ? total * (val/100) 
                                                                                    : val);
                                                                                return amt.toFixed(2);
                                                                            })()}
                                                                        </span>
                                                                    )}
                                                                    {strategyData.config?.overall_target_enabled && strategyData.totalOriginalValue > 0 && (
                                                                        <span className="text-[10px] font-mono font-medium text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 shadow-sm rounded">
                                                                            Tgt: +₹{(() => {
                                                                                const total = strategyData.totalOriginalValue;
                                                                                const val = strategyData.config.overall_target_value || 0;
                                                                                const amt = (strategyData.config.overall_target_type === 'PERCENTAGE' 
                                                                                    ? total * (val/100) 
                                                                                    : val);
                                                                                return amt.toFixed(2);
                                                                            })()}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>

                                                                                                                 <div className="flex items-center gap-1.5 shrink-0 self-start xl:self-auto" onClick={e => e.stopPropagation()}>
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-8 w-8 rounded-md text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 border border-transparent hover:border-indigo-100"
                                                                title="View Config"
                                                                onClick={() => {
                                                                    setViewConfig(strategyData.config);
                                                                    setViewStrategyName(strategyData.name || strategyData.config?.name || 'Strategy');
                                                                    setConfigWindowOpen(true);
                                                                }}
                                                            >
                                                                <Settings2 className="h-4 w-4" />
                                                            </Button>
                                                            <Button
                                                                size="icon"
                                                                variant="ghost"
                                                                className="h-8 w-8 rounded-md text-slate-500 hover:text-blue-600 hover:bg-blue-50 border border-transparent hover:border-blue-100"
                                                                title="View Logs"
                                                                onClick={() => {
                                                                    setLogStrategyId(id);
                                                                    setLogWindowOpen(true);
                                                                }}
                                                            >
                                                                <MessageSquare className="h-4 w-4" />
                                                            </Button>
                                                            {strategyData?.status === "IN_POSITION" && (
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-8 px-3 gap-1 rounded-md text-[11px] font-medium border-orange-200 bg-orange-50/50 hover:bg-orange-100 text-orange-600 shadow-sm"
                                                                    onClick={() => handleSquareOff(id)}
                                                                >
                                                                    Square Off
                                                                </Button>
                                                            )}
                                                            {strategyData?.status === "PAUSED" && (
                                                                <Button
                                                                    size="sm"
                                                                    variant="outline"
                                                                    className="h-8 px-3 gap-1.5 rounded-md text-[11px] font-medium border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100 text-emerald-600 shadow-sm"
                                                                    onClick={() => handleResume(id)}
                                                                >
                                                                    <RefreshCw className="h-3.5 w-3.5" /> Resume
                                                                </Button>
                                                            )}
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="h-8 px-3 gap-1 rounded-md text-[11px] font-medium border-red-200 bg-red-50/50 hover:bg-red-100 text-red-600 shadow-sm"
                                                                onClick={() => handleStop(id)}
                                                            >
                                                                <StopCircle className="h-3.5 w-3.5" /> Terminate
                                                            </Button>
                                                        </div>
                                                    </div>

                                                                                                         {collapsedSections[id] === true && (strategyData?.status === "IN_POSITION" || strategyData?.status === "PAUSED" || strategyData?.status === "COMPLETED") ? (
                                                        <div className="space-y-2 pt-2 border-t border-border mt-1">
                                                            {/* Strategy Legs */}

                                                            {/* Running Legs */}
                                                            {strategyData.legs?.filter(l => !l.exited || ["WAITING_FOR_RECOST", "WAITING_FOR_MNTM", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY", "WAITING_FOR_RESL_MNTM", "WAITING_FOR_RE_HIGH", "WAITING_FOR_RE_LOW"].includes(l.state)).length > 0 && (
                                                                <div className="space-y-2">
                                                                    <div
                                                                        className="flex items-center justify-between cursor-pointer group"
                                                                        onClick={() => setCollapsedSections(prev => ({ ...prev, [`${id}-running`]: prev[`${id}-running`] === true ? false : true }))}
                                                                    >
                                                                        <span className="text-[10px] font-medium uppercase text-muted-foreground group-hover:text-foreground transition-colors">Running Legs</span>
                                                                        <Button variant="ghost" size="sm" className="h-4 w-4 p-0 shrink-0 text-muted-foreground group-hover:text-foreground">
                                                                            {collapsedSections[`${id}-running`] === true ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                                                        </Button>
                                                                    </div>
                                                                    {collapsedSections[`${id}-running`] === true && (
                                                                        <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
                                                                            {strategyData.legs.map((l, idx) => (!l.exited || ["WAITING_FOR_RECOST", "WAITING_FOR_MNTM", "WAITING_FOR_RE_ASAP", "WAITING_FOR_LAZY", "WAITING_FOR_RESL_MNTM", "WAITING_FOR_RE_HIGH", "WAITING_FOR_RE_LOW"].includes(l.state)) && (
                                                                                <div key={idx} className="flex flex-col md:flex-row items-start md:items-center justify-between p-2.5 bg-white border border-border rounded-xl gap-3">
                                                                                    <div className="flex flex-col">
                                                                                        <div className="flex items-center gap-1 flex-wrap">
                                                                                            <span className="text-[12px] font-medium">{l.instrument?.symbol || "---"} ({l.leg?.side})</span>
                                                                                            <span className="text-[11px] font-medium text-slate-600">
                                                                                                {l.leg?.lots} {l.leg?.lots > 1 ? 'Lots' : 'Lot'}
                                                                                            </span>
                                                                                            <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                            <span className="text-primary font-medium text-[10px] font-mono">{l.entryTime || "---"}</span>
                                                                                            <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                            <span className="text-[10px] font-mono text-muted-foreground">Entry: {(l.entryPrice || 0).toFixed(2)}</span>
                                                                                            <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                            <span className="text-[10px] font-mono animate-pulse text-blue-600 font-medium">LTP: {(l.currentLtp || 0).toFixed(2)}</span>
                                                                                            {l.initialSlTriggerPrice != null && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-slate-500 font-medium text-[10px] font-mono">Init SL: {Number(l.initialSlTriggerPrice).toFixed(1)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.slTriggerPrice != null && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className={`text-[10px] font-mono font-black ${Number(l.slTriggerPrice) !== Number(l.initialSlTriggerPrice) ? 'text-indigo-600 animate-pulse' : 'text-slate-800'}`}>
                                                                                                        Now SL: {Number(l.slTriggerPrice).toFixed(1)}
                                                                                                    </span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.rtp != null && (l.state === "WAITING_FOR_RECOST" || l.state === "WAITING_FOR_MNTM" || l.state === "WAITING_FOR_RESL_MNTM") && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-orange-500 font-medium text-[10px] font-mono">RTP: {l.rtp.toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.mtp != null && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-purple-500 font-medium text-[10px] font-mono">MTP: {l.mtp.toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.mntmTargetPrice != null && l.state === "WAITING_FOR_SIMPLE_MNTM" && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-blue-500 font-medium animate-pulse text-[10px] font-mono">Wait Target: ₹{l.mntmTargetPrice.toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_RECOST" && (
                                                                                                <span className="px-2 py-0.5 ml-2 bg-yellow-100 text-yellow-700 font-medium rounded text-[10px] font-mono">Waiting Re-Entry (Price)</span>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_RE_ASAP" && (
                                                                                                <span className="px-2 py-0.5 ml-2 bg-blue-100 text-blue-700 font-medium rounded text-[10px] font-mono">Waiting Re-Entry (ASAP)</span>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_RESL_MNTM" && (
                                                                                                <span className="px-2 py-0.5 ml-2 bg-purple-100 text-purple-700 font-medium rounded text-[10px] font-mono whitespace-nowrap">Waiting Re-Entry (SL Price Basis)</span>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_RE_HIGH" && (
                                                                                                <>
                                                                                                    <span className="px-2 py-0.5 ml-2 bg-emerald-100 text-emerald-700 font-medium rounded text-[10px] font-mono whitespace-nowrap">Waiting Re-Entry (Peak Basis)</span>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
                                                                                                    <span className="text-indigo-600 font-bold text-[10px] font-mono ml-1 uppercase">Peak: ₹{(l.max_peak_price || 0).toFixed(2)}</span>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
                                                                                                    <span className="text-orange-600 font-bold text-[10px] font-mono ml-1 uppercase">RTP: ₹{(l.re_high_trigger_price || 0).toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_RE_LOW" && (
                                                                                                <>
                                                                                                    <span className="px-2 py-0.5 ml-2 bg-pink-100 text-pink-700 font-medium rounded text-[10px] font-mono whitespace-nowrap">Waiting Re-Entry (Low Basis)</span>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
                                                                                                    <span className="text-indigo-600 font-bold text-[10px] font-mono ml-1 uppercase">Low: ₹{(l.max_low_price || 0).toFixed(2)}</span>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
                                                                                                    <span className="text-orange-600 font-bold text-[10px] font-mono ml-1 uppercase">RTP: ₹{(l.re_low_trigger_price || 0).toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.state === "WAITING_FOR_LAZY" && (
                                                                                                <span className="px-2 py-0.5 ml-2 bg-purple-100 text-purple-700 font-medium rounded text-[10px] font-mono">Initializing Lazy Leg</span>
                                                                                            )}
                                                                                        </div>
                                                                                    </div>
                                                                                    <div className="flex items-center gap-4">
                                                                                        <div className="flex items-center gap-3">
                                                                                            <span className={`text-[12px] font-mono font-medium ${(l.currentActivePnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                                {(l.currentActivePnlPercent || 0) > 0 ? '+' : ''}{(l.currentActivePnlPercent || 0).toFixed(2)}%
                                                                                            </span>
                                                                                            <span className={`text-[12px] font-mono font-medium ${(l.currentActivePnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                                {(l.currentActivePnlRupees || 0) > 0 ? '+' : ''}₹{(l.currentActivePnlRupees || 0).toFixed(2)}
                                                                                            </span>
                                                                                        </div>
                                                                                        <Button
                                                                                            size="sm"
                                                                                            variant="outline"
                                                                                            className="rounded-lg border-orange-500 hover:bg-orange-50 text-orange-600 text-[10px] font-medium px-3 h-8"
                                                                                            onClick={() => handleSquareOffLeg(id, idx)}
                                                                                            disabled={l.isExiting}
                                                                                        >
                                                                                            {l.isExiting ? "Exiting..." :
                                                                                                (l.state === "WAITING_FOR_RECOST" || l.state === "WAITING_FOR_MNTM") ? "Cancel Re-Cost" :
                                                                                                    (l.state === "WAITING_FOR_RE_ASAP" || l.state === "WAITING_FOR_RESL_MNTM" || l.state === "WAITING_FOR_RE_HIGH" || l.state === "WAITING_FOR_RE_LOW") ? "Cancel Re-Entry" :
                                                                                                        (l.state === "WAITING_FOR_LAZY") ? "Cancel Lazy Leg" :
                                                                                                            "Square Off"}
                                                                                        </Button>
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {/* Closed Legs */}
                                                            {strategyData.legs?.filter(l => l.exited).length > 0 && (
                                                                <div className="space-y-2">
                                                                    <div
                                                                        className="flex items-center justify-between cursor-pointer group"
                                                                        onClick={() => setCollapsedSections(prev => ({ ...prev, [`${id}-closed`]: prev[`${id}-closed`] === true ? false : true }))}
                                                                    >
                                                                        <span className="text-[10px] font-medium uppercase text-muted-foreground group-hover:text-foreground transition-colors">Closed Legs</span>
                                                                        <Button variant="ghost" size="sm" className="h-4 w-4 p-0 shrink-0 text-muted-foreground group-hover:text-foreground">
                                                                            {collapsedSections[`${id}-closed`] === true ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                                                        </Button>
                                                                    </div>
                                                                    {collapsedSections[`${id}-closed`] === true && (
                                                                        <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
                                                                            {strategyData.legs.map((l, idx) => l.exited && (
                                                                                <div key={idx} className="flex flex-col md:flex-row items-start md:items-center justify-between p-2.5 bg-muted/50 border border-border/50 rounded-xl opacity-90 gap-3">
                                                                                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between w-full gap-y-2 gap-x-4">
                                                                                        <div className="flex flex-1 items-center gap-1 flex-wrap">
                                                                                            <span className="text-[12px] font-bold text-black">{l.instrument?.symbol || "---"} ({l.leg?.side})</span>
                                                                                            <span className="text-[11px] font-bold text-black/40">
                                                                                                {l.leg?.lots} {l.leg?.lots > 1 ? 'Lots' : 'Lot'}
                                                                                            </span>
                                                                                            <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                            <span className="text-black font-bold text-[10px] font-mono">{l.entryTime || "---"}</span>
                                                                                            <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                            <span className="text-[10px] font-mono text-black">Entry: {(l.entryPrice || 0).toFixed(2)}</span>
                                                                                            <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                            <span className="text-black font-bold text-[10px] font-mono">Exit: {l.exitTime || l.exitSnapshot?.exitTime || "---"}</span>
                                                                                            <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                            <span className="text-black text-[10px] font-mono">Price: {(l.exitSnapshot?.exitLtp || l.currentLtp || 0).toFixed(2)}</span>
                                                                                            <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                            <span className="text-black text-[10px] font-mono font-bold">Type: {l.exitType}</span>
                                                                                            {l.initialSlTriggerPrice != null && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-red-400 font-medium text-[10px] font-mono">Init SL: {Number(l.initialSlTriggerPrice).toFixed(1)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.exitSnapshot?.slTriggerPrice != null && (
                                                                                                <>
                                                                                                    <span className="text-muted-foreground text-[10px] font-mono">|</span>
                                                                                                    <span className="text-red-600 font-bold text-[10px] font-mono">Exit SL: {Number(l.exitSnapshot.slTriggerPrice).toFixed(1)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.rtp != null && (
                                                                                                <>
                                                                                                    <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                                    <span className="text-orange-600 font-bold text-[10px] font-mono">RTP: {l.rtp.toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                            {l.mtp != null && (
                                                                                                <>
                                                                                                    <span className="text-black/30 text-[10px] font-mono">|</span>
                                                                                                    <span className="text-purple-600 font-bold text-[10px] font-mono">MTP: {l.mtp.toFixed(2)}</span>
                                                                                                </>
                                                                                            )}
                                                                                        </div>
                                                                                        <div className="flex items-center gap-3 shrink-0">
                                                                                            <span className={`text-[12px] font-mono font-medium ${(l.pnlPercent || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                                {(l.pnlPercent || 0) > 0 ? '+' : ''}{(l.pnlPercent || 0).toFixed(2)}%
                                                                                            </span>
                                                                                            <span className={`text-[12px] font-mono font-medium ${(l.pnlRupees || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                                                                {(l.pnlRupees || 0) > 0 ? '+' : ''}₹{(l.pnlRupees || 0).toFixed(2)}
                                                                                            </span>
                                                                                            <span className="px-2 py-0.5 text-[10px] font-bold bg-slate-200 text-black rounded uppercase">Closed</span>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ) : null}
                                                </CardContent>
                                            </Card>
                                        ))}
                                    {Object.entries(runningStrategies).filter(([_, strategyData]) => {
                                        const isPaper = !!strategyData.config?.is_paper_trading;
                                        return activeTab === 'paper' ? isPaper : !isPaper;
                                    }).length === 0 && (
                                        <div className="flex flex-col items-center justify-center p-12 bg-white border-2 border-dashed border-slate-200 rounded-[2rem] text-center">
                                            <div className="h-16 w-16 bg-slate-50 text-slate-300 rounded-2xl flex items-center justify-center mb-4">
                                                <Play className="h-8 w-8" />
                                            </div>
                                            <h3 className="text-sm font-medium text-slate-900">No {activeTab === 'paper' ? 'Paper' : 'Live'} Strategies Active</h3>
                                            <p className="text-xs text-slate-500 mt-1">Deploy a strategy from your templates to see it here.</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )
                }

                <TabsList className="grid w-full grid-cols-2 mb-4 mt-8 h-10 bg-muted/50 p-1 rounded-lg shadow-sm">
                    <TabsTrigger value="paper" className="rounded-md font-medium text-[11px] data-[state=active]:bg-blue-600 data-[state=active]:text-white flex items-center gap-2 transition-all">
                        <ShieldCheck className="h-4 w-4" /> Paper Trading
                    </TabsTrigger>
                    <TabsTrigger value="live" className="rounded-md font-medium text-[11px] data-[state=active]:bg-orange-600 data-[state=active]:text-white flex items-center gap-2 transition-all">
                        <Zap className="h-4 w-4" /> Live Market
                    </TabsTrigger>
                </TabsList>

                {
                    savedStrategies.length > 0 && (
                        <Card className="w-full border-border bg-card mt-2">
                            <div
                                className="border-b bg-muted/60 py-3 px-4 flex flex-col md:flex-row items-center justify-between gap-2 cursor-pointer hover:bg-muted/80 transition-colors"
                                onClick={(e) => {
                                    if (e.target.closest('input')) return;
                                    setCollapsedSections(prev => ({ ...prev, 'saved-strategies': !prev['saved-strategies'] }));
                                }}
                            >
                                <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                                    <Save className="h-4 w-4 text-primary" /> Saved Strategies
                                </CardTitle>
                                <div className="flex items-center gap-3 w-full md:w-auto">
                                    <div className="relative w-full md:w-64" onClick={e => e.stopPropagation()}>
                                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                        <Input
                                            type="text"
                                            placeholder="Search by strategy name or ID..."
                                            className="h-8 pl-8 pr-3 rounded-lg text-[10px] bg-white/50 border-none shadow-sm focus-visible:ring-1 focus-visible:ring-primary/20"
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                        />
                                    </div>
                                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
                                        {collapsedSections['saved-strategies'] ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                            {!collapsedSections['saved-strategies'] && (
                                <CardContent className="p-0 animate-in fade-in slide-in-from-top-2 duration-200">
                                    <div className="flex flex-col w-full">
                                        {/* Desktop Header */}
                                        <div className="hidden lg:grid lg:grid-cols-12 gap-4 px-4 py-2 bg-muted text-black border-b text-[10px] font-black uppercase tracking-wider items-center">
                                            <div className="col-span-3">Name</div>
                                            <div className="col-span-2">Date Created</div>
                                            <div className="col-span-1">Index</div>
                                            <div className="col-span-3">Type</div>
                                            <div className="col-span-3 text-right">Actions</div>
                                        </div>
                                        <div className="divide-y border-t flex flex-col">
                                                {savedStrategies
                                                    .filter(s => {
                                                        const name = (s.name || s.config?.name || '').toLowerCase();
                                                        const id = (s.id || '').toLowerCase();
                                                        const search = searchTerm.toLowerCase();
                                                        return name.includes(search) || id.includes(search);
                                                    })
                                                    .map((s) => (
                                                        <div
                                                            key={s.id}
                                                            className="grid grid-cols-1 xl:grid-cols-12 gap-2 xl:gap-4 px-4 py-3 xl:items-center hover:bg-muted/50 transition-colors cursor-grab active:cursor-grabbing bg-card mobile-strategy-row"
                                                            draggable
                                                            onDragStart={(e) => {
                                                                e.dataTransfer.effectAllowed = 'move';
                                                                e.dataTransfer.setData('text/plain', s.id);
                                                                setTimeout(() => { if (e.target && e.target.classList) e.target.classList.add('opacity-40'); }, 0);
                                                            }}
                                                            onDragEnd={(e) => {
                                                                if (e.target && e.target.classList) {
                                                                    e.target.classList.remove('opacity-40');
                                                                    e.target.classList.remove('border-t-2', 'border-b-2', 'border-primary', 'bg-muted/30');
                                                                }
                                                            }}
                                                            onDragOver={(e) => {
                                                                e.preventDefault();
                                                                e.dataTransfer.dropEffect = 'move';
                                                                if (e.currentTarget) {
                                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                                    const isTopHalf = e.clientY < rect.top + rect.height / 2;
                                                                    e.currentTarget.classList.remove('border-t-2', 'border-b-2', 'border-primary');
                                                                    e.currentTarget.classList.add(isTopHalf ? 'border-t-2' : 'border-b-2', 'border-primary');
                                                                }
                                                            }}
                                                            onDragEnter={(e) => {
                                                                e.preventDefault();
                                                                if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('bg-muted/30');
                                                            }}
                                                            onDragLeave={(e) => {
                                                                if (e.currentTarget && e.currentTarget.classList) {
                                                                    e.currentTarget.classList.remove('bg-muted/30', 'border-t-2', 'border-b-2', 'border-primary');
                                                                }
                                                            }}
                                                            onDrop={(e) => {
                                                                e.preventDefault();
                                                                if (e.currentTarget && e.currentTarget.classList) {
                                                                    e.currentTarget.classList.remove('bg-muted/30', 'border-t-2', 'border-b-2', 'border-primary');
                                                                }
                                                                const sourceId = e.dataTransfer.getData('text/plain');
                                                                if (!sourceId || sourceId === s.id) return;

                                                                // Determine precise drop location
                                                                const rect = e.currentTarget.getBoundingClientRect();
                                                                const isTopHalf = e.clientY < rect.top + rect.height / 2;

                                                                setSavedStrategies(prev => {
                                                                    const sourceIndex = prev.findIndex(item => item.id === sourceId);
                                                                    if (sourceIndex === -1) return prev;

                                                                    const next = [...prev];
                                                                    const [movedItem] = next.splice(sourceIndex, 1);

                                                                    // adjusted index after moving the item out
                                                                    let adjustedTargetIndex = next.findIndex(item => item.id === s.id);
                                                                    if (adjustedTargetIndex === -1) return prev; // Fallback

                                                                    // Insert before or after
                                                                    const insertIndex = isTopHalf ? adjustedTargetIndex : adjustedTargetIndex + 1;
                                                                    next.splice(insertIndex, 0, movedItem);

                                                                    localStorage.setItem('custom_strategy_order', JSON.stringify(next.map(item => item.id)));
                                                                    return next;
                                                                });
                                                            }}
                                                        >
                                                            <div className="col-span-1 xl:col-span-3 font-medium text-[12px] flex items-start xl:items-center gap-2">
                                                                <div className="p-1 rounded text-black hover:text-black transition-colors mt-0.5 xl:mt-0">
                                                                    <GripVertical className="h-4 w-4 shrink-0" />
                                                                </div>
                                                                <div>
                                                                    {s.name || s.config?.name || 'Unnamed Strategy'}
                                                                    <div className="text-[9px] font-mono text-black font-normal">ID: {s.id.split('-')[0] || s.id}</div>
                                                                </div>
                                                            </div>
                                                            <div className="col-span-1 xl:col-span-2 font-mono text-[11px] xl:text-[10px] text-black xl:text-black flex xl:block items-center justify-between">
                                                                <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider">Created</span>
                                                                <span>{new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                            </div>
                                                            <div className="col-span-1 xl:col-span-1 font-medium text-[12px] xl:text-[10px] flex xl:block items-center justify-between">
                                                                <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider">Index</span>
                                                                <span>{s.config?.index}</span>
                                                            </div>
                                                            <div className="col-span-1 xl:col-span-3 flex xl:block items-center justify-between">
                                                                <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider pr-4">Type</span>
                                                                <span className="px-1.5 py-0.5 rounded text-[10px] xl:text-[9px] font-medium bg-slate-100 text-black text-right xl:text-left line-clamp-2">
                                                                    {s.config?.legs?.map((l) => `${l.side} ${l.option_type} (${l.lots} ${l.lots > 1 ? 'L' : 'L'})`).join(' | ') || '---'}
                                                                </span>
                                                            </div>
                                                            <div className="col-span-1 xl:col-span-3 text-right mt-2 xl:mt-0 pt-3 xl:pt-0 border-t border-dashed border-gray-100 xl:border-none">
                                                                <div className="flex flex-wrap items-center justify-start xl:justify-end gap-1.5 w-full">
                                                                    <Button
                                                                        size="sm"
                                                                        className={`h-8 xl:h-7 px-3 gap-1 rounded-md text-[11px] xl:text-[10px] font-medium shadow-sm flex-1 xl:flex-none ${!isConnected ? 'opacity-50 grayscale cursor-not-allowed' : ''}`}
                                                                        onClick={() => handleExecute(s.id)}
                                                                        disabled={!isConnected}
                                                                        title={!isConnected ? "Please connect to Angel One to execute strategies" : ""}
                                                                    >
                                                                        <Play className="h-3 w-3 fill-current" /> Deploy
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        className="h-8 xl:h-7 px-3 gap-1 rounded-md text-[11px] xl:text-[10px] font-medium border-indigo-500 hover:bg-indigo-50 text-indigo-600 shadow-sm flex-1 xl:flex-none"
                                                                        onClick={() => {
                                                                            setViewConfig(s.config);
                                                                            setViewStrategyName(s.name || s.config?.name || 'Strategy');
                                                                            setConfigWindowOpen(true);
                                                                        }}
                                                                    >
                                                                        <Settings2 className="h-3 w-3" /> View
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        className="h-8 xl:h-7 px-2.5 rounded-md text-[11px] xl:text-[10px] flex-1 xl:flex-none"
                                                                        onClick={() => handleEdit(s)}
                                                                    >
                                                                        Edit
                                                                    </Button>
                                                                    <Button
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        className="h-8 xl:h-7 px-3 rounded-md text-[11px] xl:text-[10px] text-destructive hover:text-destructive hover:bg-red-50 flex-none"
                                                                        onClick={() => handleDelete(s.id)}
                                                                    >
                                                                        <Trash2 className="h-4 w-4 xl:h-3 xl:w-3" />
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                        </div>
                                    </div>
                                </CardContent>
                            )}
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
