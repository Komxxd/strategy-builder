import React, { useState, useEffect, useRef } from'react';
import { createPortal } from'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from'@/components/ui/card';
import { Button } from'@/components/ui/button';
import { Input } from'@/components/ui/input';
import { Label } from'@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from'@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from'@/components/ui/tabs';
import { StopCircle, Loader2, TrendingUp, Search, Timer, LayoutDashboard, Target, Save, Play, Plus, Trash2, ShieldCheck, Zap, Copy, MessageSquare, Ghost, X, Settings2, Clock, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, GripVertical, RefreshCw, Sliders, Eye, Database, Archive, Download, Upload, FileText, FolderPlus, Check, MoreVertical } from'lucide-react';
import { FolderTree } from './FolderTree';
import { Switch } from"@/components/ui/switch";
import axios from'axios';
import { io } from'socket.io-client';
import { StrategyLogs } from'./StrategyLogs';
import { StrategyConfigModal } from'./StrategyConfigModal';
import { ExecutionSettingsModal } from'./ExecutionSettingsModal';
import { fetchBacktestDates, runBacktest, runCombinedBacktest, getBacktestStatus } from'../api';
import { downloadElementAsPdf } from '../utils/pdfExport';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ||"http://localhost:5001/api";
const SOCKET_URL = API_BASE_URL.replace(/\/api\/?$/,"");

// States in which an exited leg is still waiting for re-entry (used in multiple places)
const REENTRY_WAITING_STATES = [
  "WAITING_FOR_RECOST",
  "WAITING_FOR_MNTM",
  "WAITING_FOR_RE_ASAP",
  "WAITING_FOR_LAZY",
  "WAITING_FOR_RESL_MNTM",
  "WAITING_FOR_RE_HIGH",
  "WAITING_FOR_RE_LOW",
  "WAITING_FOR_SIMPLE_MNTM",
  "WAITING_FOR_FILL",
  "WAITING_FOR_INTERNAL_FALLBACK"
];

// Removed interceptor, handled globally in App.jsx

const DEFAULT_LEG = {
 expiry_type:'weekly',
 strike_criteria:'STRIKE_TYPE',
 option_type:'CE',
 strike:'ATM',
 premium: 0,
 side:'BUY',
 lots: 1,
 sl_type:'PERCENTAGE',
 sl_enabled: true,
 stop_loss: 10,
 simple_mntm_enabled: false,
 simple_mntm_mode:'SIMPLE_PLUS_PCT',
 simple_mntm_value: 0,
 recost_enabled: false,
 recost_mode:'RECOST_PLUS_PCT',
 recost_value: 0,
 recost_mntm_enabled: false,
 resl_enabled: false,
 resl_mode:'RESL_PLUS_PCT',
 resl_value: 0,
 resl_mntm_enabled: false,
 rehigh_enabled: false,
 rehigh_mode:'REHIGH_MINUS_PTS',
 rehigh_value: 1,
 rehigh_mntm_enabled: false,
 rehigh_mntm_mode:'REHIGH_PLUS_PTS',
 rehigh_mntm_value: 0,
 relow_enabled: false,
 relow_mode:'RELOW_PLUS_PTS',
 relow_value: 1,
 relow_mntm_enabled: false,
 relow_mntm_mode:'RELOW_PLUS_PTS',
 relow_mntm_value: 0,
 max_reentry: 1,
 no_reentry_on_sl_candle: false,
 reentry_sl_enabled: false,
 reentry_sl_type:'PERCENTAGE',
 reentry_sl_value: 10,
 re_asap_enabled: false,
 re_asap_max_entries: 1,
 lazy_leg_enabled: false,
 lazy_leg: null,
 tsl_enabled: false,
 tsl_type:'PERCENTAGE',
 tsl_move: 0,
 tsl_trail: 0,
 tsl_on_close: false,
 tsl_on_close_low: false,
 tsl_on_close_high: false,
 reentry_tsl_on_close: false,
 reentry_tsl_on_close_low: false,
 reentry_tsl_on_close_high: false
};


const getLegSummary = (leg) => {
 if (!leg) return'Not configured';
 const strike = leg.strike_criteria ==='CLOSEST_PREMIUM' ?`₹${leg.premium || 0}` : (leg.strike ||'ATM');
 let summary =`${leg.side ||'BUY'} ${leg.option_type ||'CE'} ${strike} (SL ${leg.stop_loss || 0}${leg.sl_type ==='POINTS' ?'pts' :'%'})`;
 if (leg.tsl_enabled) {
 summary +=` [TSL ${leg.tsl_move || 0}${leg.tsl_type ==='POINTS' ?'pts' :'%'} | Trl: ${leg.tsl_trail || 0}]`;
 }
 return summary;
};

const CalendarPicker = ({ availableDates, dateRange, onSelect }) => {
 const datesSet = new Set(availableDates);
 const initialDate = availableDates.length > 0 ? new Date(availableDates[availableDates.length - 1]) : new Date();
 const [currentMonth, setCurrentMonth] = useState(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));

 const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
 const firstDayOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();

 const prevMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
 const nextMonth = () => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));

 const minMonthStr = availableDates.length > 0 ? availableDates[0].substring(0, 7) :"";
 const maxMonthStr = availableDates.length > 0 ? availableDates[availableDates.length - 1].substring(0, 7) :"";

 const today = new Date();
 const todayStr =`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
 const currentMonthActualStr = todayStr.substring(0, 7);

 const effectiveMaxMonthStr = maxMonthStr > currentMonthActualStr ? currentMonthActualStr : maxMonthStr;

 const currentMonthStr =`${currentMonth.getFullYear()}-${String(currentMonth.getMonth() + 1).padStart(2,'0')}`;

 const canGoPrev = currentMonthStr > minMonthStr;
 const canGoNext = currentMonthStr < effectiveMaxMonthStr;

 const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];

 const days = [];
 for (let i = 0; i < firstDayOfMonth; i++) {
 days.push(<div key={`empty-start-${i}`} className="h-7 w-7"></div>);
 }

 for (let i = 1; i <= daysInMonth; i++) {
 const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), i);
 const dateString =`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

 const isFrom = dateRange.from === dateString;
 const isTo = dateRange.to === dateString;
 const isSelected = isFrom || isTo;
 const isInRange = dateRange.from && dateRange.to && dateString > dateRange.from && dateString < dateRange.to;
 const isFuture = dateString > todayStr;

 days.push(
 <button
 key={dateString}
 disabled={isFuture}
 onClick={() => onSelect(dateString)}
 className={`h-7 w-7 rounded-md flex items-center justify-center text-xs font-semibold transition-colors ${isSelected ?'bg-slate-900 text-white' :
 isInRange ?'bg-indigo-50 text-indigo-700' :
 isFuture ?'text-slate-300 cursor-not-allowed opacity-40' :
'bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer'
 }`}
 title={isFuture ?'Future dates cannot be selected' :''}
 >
 {i}
 </button>
 );
 }

 const totalCells = days.length;
 for (let i = 0; i < 42 - totalCells; i++) {
 days.push(<div key={`empty-end-${i}`} className="h-7 w-7"></div>);
 }

 return (
 <div className="w-full">
 <div className="flex items-center justify-between mb-3">
 <Button variant="ghost" size="sm" className="h-6 w-6 p-0 rounded-md hover:bg-slate-100" onClick={prevMonth} disabled={!canGoPrev}><ChevronLeft className="h-3.5 w-3.5 text-slate-600" /></Button>
 <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700">
 {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
 </div>
 <Button variant="ghost" size="sm" className="h-6 w-6 p-0 rounded-md hover:bg-slate-100" onClick={nextMonth} disabled={!canGoNext}><ChevronRight className="h-3.5 w-3.5 text-slate-600" /></Button>
 </div>
 <div className="grid grid-cols-7 gap-1 mb-1.5 text-center text-[9px] font-bold text-slate-400 uppercase tracking-widest">
 <div>Su</div><div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div>
 </div>
 <div className="grid grid-cols-7 gap-1 place-items-center">
 {days}
 </div>
 </div>
 );
};

const LazyLegModal = ({ isOpen, onClose, leg, onChange, legIndex, level }) => {
 useEffect(() => {
 if (isOpen) {
 document.body.style.overflow ='hidden';
 } else {
 document.body.style.overflow ='unset';
 }
 return () => { document.body.style.overflow ='unset'; };
 }, [isOpen]);

 if (!isOpen) return null;

 const modalContent = (
 <div
 className="fixed inset-0 z-[999999] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md transition-all duration-500 animate-in fade-in"
 onClick={(e) => e.target === e.currentTarget && onClose()}
 >
 <div className="bg-white w-full max-w-4xl max-h-[90vh] flex flex-col rounded-[2.5rem] )] border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-10 duration-500 ease-out">
 {/* Header */}
 <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
 <div className="flex items-center gap-4">
 <div className="h-12 w-12 bg-orange-500 rounded-2xl flex items-center justify-center">
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
 <Button onClick={onClose} className="rounded-xl px-8 font-medium h-12">
 Confirm Configuration
 </Button>
 </div>
 </div>
 <style dangerouslySetInnerHTML={{
 __html:`
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
 const idPrefix = isRecursive ?`lazy-${level}-${legIndex}` :`leg-${legIndex}`;
 const [isLazyModalOpen, setIsLazyModalOpen] = useState(false);

 return (
 <div className={`p-2 rounded-lg border-2 transition-all duration-300 ${isRecursive ?'bg-muted/30 border-dashed mt-2 ml-4 md:ml-6 border-primary/20' :'bg-card border-primary/10 hover:border-primary/30'}`}>
 <div className="flex items-center justify-between mb-2">
 <div className="flex items-center gap-1.5">
 <div className={`h-8 w-8 ${isRecursive ?'bg-orange-500/10 text-orange-600' :'bg-primary/10 text-primary'} rounded flex items-center justify-center font-medium text-[11px]`}>
 {legIndex + 1}
 </div>
 <div>
 <h3 className="font-medium text-[11px] tracking-tight">
 {isRecursive ?`Lazy Leg (Level ${level})` :`Strategy Leg ${legIndex + 1}`}
 </h3>
 <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">
 {isRecursive ?'Placed after parent SL hits' :'Initial Entry Leg'}
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
 title={!canRemove ?"At least one leg is required" :"Remove leg"}
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
 Expiry
 </Label>
 <Select
 value={leg.expiry_type ||'weekly'}
 onValueChange={(v) => onChange({ ...leg, expiry_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[12px]">
 <SelectValue placeholder="Expiry" />
 </SelectTrigger>
 <SelectContent>
 <SelectItem value="weekly">Weekly</SelectItem>
 <SelectItem value="next_weekly">Next Weekly</SelectItem>
 <SelectItem value="monthly">Monthly</SelectItem>
 <SelectItem value="next_monthly">Next Monthly</SelectItem>
 </SelectContent>
 </Select>
 </div>

 <div className="space-y-1.5 flex-1 min-w-[80px] sm:min-w-[100px]">
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
 value={leg.strike_criteria ||'STRIKE_TYPE'}
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

 {leg.strike_criteria ==='CLOSEST_PREMIUM' ? (
 <div className="space-y-1 flex-1 min-w-[100px] sm:min-w-[120px]">
 <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-2">
 Premium (₹)
 </Label>
 <Input
 className="h-9 rounded-lg text-[12px] w-full"
 type="text"
 value={leg.premium === undefined ?'' : leg.premium}
 onChange={(e) => {
 const val = e.target.value;
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
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
 value={leg.sl_type ||'PERCENTAGE'}
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
 value={leg.tsl_type ||'PERCENTAGE'}
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
 value={leg.tsl_move === 0 ?'' : (leg.tsl_move !== undefined ? leg.tsl_move :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, tsl_move: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>

 <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
 <Input
 className="h-9 w-full rounded-lg text-[11px] focus:ring-emerald-500"
 type="number"
 placeholder="Trail"
 value={leg.tsl_trail === 0 ?'' : (leg.tsl_trail !== undefined ? leg.tsl_trail :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, tsl_trail: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>

 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`tsl-on-close-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.tsl_on_close || false}
 onChange={(e) => onChange({ ...leg, tsl_on_close: e.target.checked, tsl_on_close_low: false, tsl_on_close_high: false })}
 />
 <Label htmlFor={`tsl-on-close-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap">On Close</Label>
 </div>

 {leg.tsl_on_close && leg.side === 'SELL' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`tsl-on-close-low-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
 checked={leg.tsl_on_close_low || false}
 onChange={(e) => onChange({ ...leg, tsl_on_close_low: e.target.checked })}
 />
 <Label htmlFor={`tsl-on-close-low-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-pink-600">On Close Low</Label>
 </div>
 )}

 {leg.tsl_on_close && leg.side === 'BUY' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`tsl-on-close-high-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
 checked={leg.tsl_on_close_high || false}
 onChange={(e) => onChange({ ...leg, tsl_on_close_high: e.target.checked })}
 />
 <Label htmlFor={`tsl-on-close-high-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-emerald-600">On Close High</Label>
 </div>
 )}
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
 value={leg.simple_mntm_mode ||'SIMPLE_PLUS_PCT'}
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
 value={leg.simple_mntm_value === 0 ?'' : (leg.simple_mntm_value !== undefined ? leg.simple_mntm_value :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, simple_mntm_value: val ==='' ? 0 : parseFloat(val) });
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
 value={leg.lazy_leg_enabled ?'LAZY_LEG' : (leg.recost_enabled ?'RE_COST' : (leg.resl_enabled ?'RE_SL' : (leg.rehigh_enabled ?'RE_HIGH' : (leg.relow_enabled ?'RE_LOW' :'RE_ASAP'))))}
 onValueChange={(v) => {
 const isReHigh = v ==='RE_HIGH';
 const isReLow = v ==='RE_LOW';
 onChange({
 ...leg,
 re_asap_enabled: v ==='RE_ASAP',
 recost_enabled: v ==='RE_COST',
 resl_enabled: v ==='RE_SL',
 rehigh_enabled: isReHigh,
 relow_enabled: isReLow,
 lazy_leg_enabled: v ==='LAZY_LEG',
 lazy_leg: v ==='LAZY_LEG' ? (leg.lazy_leg || { ...DEFAULT_LEG }) : leg.lazy_leg,
 // Specifics for RE HIGH
 rehigh_mode: isReHigh ?'REHIGH_MINUS_PTS' : (leg.rehigh_mode ||'REHIGH_MINUS_PTS'),
 rehigh_value: isReHigh ? 1 : (leg.rehigh_value || 1),
 rehigh_mntm_enabled: isReHigh ? false : leg.rehigh_mntm_enabled,
 rehigh_mntm_mode: isReHigh ?'REHIGH_PLUS_PTS' : (leg.rehigh_mntm_mode ||'REHIGH_PLUS_PTS'),
 rehigh_mntm_value: isReHigh ? 0 : (leg.rehigh_mntm_value || 0),
 // Specifics for RE LOW
 relow_mode: isReLow ?'RELOW_PLUS_PTS' : (leg.relow_mode ||'RELOW_PLUS_PTS'),
 relow_value: isReLow ? 1 : (leg.relow_value || 1),
 relow_mntm_enabled: isReLow ? false : leg.relow_mntm_enabled,
 relow_mntm_mode: isReLow ?'RELOW_PLUS_PTS' : (leg.relow_mntm_mode ||'RELOW_PLUS_PTS'),
 relow_mntm_value: isReLow ? 0 : (leg.relow_mntm_value || 0)
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
 <div className="flex items-center gap-1.5 mb-3">
 <input
 type="checkbox"
 id={`no-reentry-sl-candle-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.no_reentry_on_sl_candle || false}
 onChange={(e) => onChange({ ...leg, no_reentry_on_sl_candle: e.target.checked })}
 />
 <Label htmlFor={`no-reentry-sl-candle-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-gray-700 font-medium">No Re-Entry on SL Candle</Label>
 </div>
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
 value={leg.recost_mode ||'RECOST_PLUS_PCT'}
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
 Value {leg.recost_mode && leg.recost_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[9px]"
 type="text"
 value={leg.recost_value === undefined ?'' : leg.recost_value}
 onChange={(e) => {
 const val = e.target.value;
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
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
 {num} {num === 1 ?'Entry' :'Entries'}
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
 value={leg.recost_mntm_mode ||'RECOST_PLUS_PCT'}
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
 Value {leg.recost_mntm_mode && leg.recost_mntm_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="text"
 value={leg.recost_mntm_value === undefined ?'' : leg.recost_mntm_value}
 onChange={(e) => {
 const val = e.target.value;
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
 onChange({ ...leg, recost_mntm_value: val });
 }
 }}
 onBlur={(e) => onChange({ ...leg, recost_mntm_value: parseFloat(e.target.value) || 0 })}
 />
 </div>
 </div>
 )}

 <div className="w-full flex flex-col lg:flex-row items-start gap-2 lg:gap-4 pt-1">
 <div className="w-full lg:flex-1 space-y-1.5">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override SL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_sl_enabled || false}
 onCheckedChange={(val) => {
 const updatedLeg = { ...leg, reentry_sl_enabled: val };
 if (!val) updatedLeg.reentry_tsl_enabled = false;
 onChange(updatedLeg);
 }}
 />
 </div>
 {leg.reentry_sl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_sl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 value={leg.reentry_sl_value === 0 ?'' : (leg.reentry_sl_value !== undefined ? leg.reentry_sl_value :'')}
 placeholder={leg.stop_loss ||"0"}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_sl_value: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 </div>
 )}
 </div>

 {leg.reentry_sl_enabled && (
 <div className="w-full lg:flex-1 space-y-1.5 animate-in fade-in slide-in-from-left-2">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override TSL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_tsl_enabled || false}
 onCheckedChange={(val) => onChange({ ...leg, reentry_tsl_enabled: val })}
 />
 </div>
 {leg.reentry_tsl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_tsl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_tsl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Move"
 value={leg.reentry_tsl_move === 0 ?'' : (leg.reentry_tsl_move !== undefined ? leg.reentry_tsl_move :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_move: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
 <Input
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Trail"
 value={leg.reentry_tsl_trail === 0 ?'' : (leg.reentry_tsl_trail !== undefined ? leg.reentry_tsl_trail :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_trail: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>

 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-recost-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close: e.target.checked, reentry_tsl_on_close_low: false, reentry_tsl_on_close_high: false })}
 />
 <Label htmlFor={`reentry-tsl-on-close-recost-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap">On Close</Label>
 </div>

 {leg.reentry_tsl_on_close && leg.side === 'SELL' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-low-recost-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_low || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_low: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-low-recost-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-pink-600">On Close Low</Label>
 </div>
 )}

 {leg.reentry_tsl_on_close && leg.side === 'BUY' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-high-recost-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_high || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_high: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-high-recost-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-emerald-600">On Close High</Label>
 </div>
 )}
 </div>
 )}
 </div>
 )}
 </div>
 </div>
 </div>
 )}

 {leg.resl_enabled && (
 <div className="space-y-2">
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
 <div className="space-y-1">
 <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">RE SL Mode</Label>
 <Select
 value={leg.resl_mode ||'RESL_PLUS_PCT'}
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
 Value {leg.resl_mode && leg.resl_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[9px]"
 type="text"
 value={leg.resl_value === undefined ?'' : leg.resl_value}
 onChange={(e) => {
 const val = e.target.value;
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
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
 {num} {num === 1 ?'Entry' :'Entries'}
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
 value={leg.resl_mntm_mode ||'RESL_PLUS_PCT'}
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
 Value {leg.resl_mntm_mode && leg.resl_mntm_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="text"
 value={leg.resl_mntm_value === undefined ?'' : leg.resl_mntm_value}
 onChange={(e) => {
 const val = e.target.value;
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
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
 onChange={(e) => {
 const val = e.target.checked;
 const updatedLeg = { ...leg, reentry_sl_enabled: val };
 if (!val) updatedLeg.reentry_tsl_enabled = false;
 onChange(updatedLeg);
 }}
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
 value={leg.reentry_sl_type ||'PERCENTAGE'}
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
 Value {leg.reentry_sl_type ==='POINTS' ?'(Pts)' :'(%)'}
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

 {leg.reentry_sl_enabled && (
 <>
 <div className="flex items-center gap-2 pt-1">
 <input
 type="checkbox"
 id={`resl-tsl-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.reentry_tsl_enabled || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_enabled: e.target.checked })}
 />
 <Label htmlFor={`resl-tsl-${idPrefix}`} className="text-[10px] font-medium tracking-wide text-foreground cursor-pointer uppercase">
 Override TSL on Re-Entry
 </Label>
 </div>

 {leg.reentry_tsl_enabled && (
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pl-5 animate-in slide-in-from-top-2 border-l-2 border-primary/20">
 <div className="space-y-1">
 <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">TSL Type</Label>
 <Select
 value={leg.reentry_tsl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_tsl_type: v })}
 >
 <SelectTrigger className="h-9 rounded-lg text-[10px]">
 <SelectValue placeholder="TSL Type" />
 </SelectTrigger>
 <SelectContent>
 <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
 <SelectItem value="POINTS">Points (Pts)</SelectItem>
 </SelectContent>
 </Select>
 </div>
 <div className="space-y-1">
 <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Move</Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="number"
 value={leg.reentry_tsl_move !== undefined ? leg.reentry_tsl_move : (leg.tsl_move || 0)}
 onChange={(e) => onChange({ ...leg, reentry_tsl_move: parseFloat(e.target.value) })}
 />
 </div>
 <div className="space-y-1">
 <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">Trail</Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="number"
 value={leg.reentry_tsl_trail !== undefined ? leg.reentry_tsl_trail : (leg.tsl_trail || 0)}
 onChange={(e) => onChange({ ...leg, reentry_tsl_trail: parseFloat(e.target.value) })}
 />
 </div>

 <div className="flex items-center gap-1.5 pt-1">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-resl-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close: e.target.checked, reentry_tsl_on_close_low: false, reentry_tsl_on_close_high: false })}
 />
 <Label htmlFor={`reentry-tsl-on-close-resl-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap">On Close</Label>
 </div>

 {leg.reentry_tsl_on_close && leg.side === 'SELL' && (
 <div className="flex items-center gap-1.5 pt-1">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-low-resl-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_low || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_low: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-low-resl-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-pink-600">On Close Low</Label>
 </div>
 )}

 {leg.reentry_tsl_on_close && leg.side === 'BUY' && (
 <div className="flex items-center gap-1.5 pt-1">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-high-resl-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_high || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_high: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-high-resl-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-emerald-600">On Close High</Label>
 </div>
 )}
 </div>
 )}
 </>
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
 value={leg.rehigh_mode ||'REHIGH_MINUS_PTS'}
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
 value={leg.rehigh_value === undefined || leg.rehigh_value ==='' ?'' : leg.rehigh_value}
 onChange={(e) => onChange({ ...leg, rehigh_value: e.target.value ==='' ?'' : parseFloat(e.target.value) })}
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
 {num} {num === 1 ?'Entry' :'Entries'}
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
 value={leg.rehigh_mntm_mode ||'REHIGH_PLUS_PCT'}
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
 Value {leg.rehigh_mntm_mode && leg.rehigh_mntm_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="number"
 value={leg.rehigh_mntm_value === undefined ?'' : leg.rehigh_mntm_value}
 onChange={(e) => {
 const val = parseFloat(e.target.value);
 // Prevent values <= 0
 if (!isNaN(val) && val >= 0) {
 onChange({ ...leg, rehigh_mntm_value: val });
 } else if (e.target.value ==='') {
 onChange({ ...leg, rehigh_mntm_value:'' });
 }
 }}
 onBlur={(e) => {
 const val = parseFloat(e.target.value);
 if (isNaN(val)) {
 onChange({ ...leg, rehigh_mntm_value: 0 });
 }
 }}
 />
 </div>
 </div>
 )}

 <div className="w-full flex flex-col lg:flex-row items-start gap-2 lg:gap-4 pt-1">
 <div className="w-full lg:flex-1 space-y-1.5">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override SL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_sl_enabled || false}
 onCheckedChange={(val) => {
 const updatedLeg = { ...leg, reentry_sl_enabled: val };
 if (!val) updatedLeg.reentry_tsl_enabled = false;
 onChange(updatedLeg);
 }}
 />
 </div>
 {leg.reentry_sl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_sl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 value={leg.reentry_sl_value === 0 ?'' : (leg.reentry_sl_value !== undefined ? leg.reentry_sl_value :'')}
 placeholder={leg.stop_loss ||"0"}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_sl_value: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 </div>
 )}
 </div>

 {leg.reentry_sl_enabled && (
 <div className="w-full lg:flex-1 space-y-1.5 animate-in fade-in slide-in-from-left-2">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override TSL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_tsl_enabled || false}
 onCheckedChange={(val) => onChange({ ...leg, reentry_tsl_enabled: val })}
 />
 </div>
 {leg.reentry_tsl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_tsl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_tsl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Move"
 value={leg.reentry_tsl_move === 0 ?'' : (leg.reentry_tsl_move !== undefined ? leg.reentry_tsl_move :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_move: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
 <Input
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Trail"
 value={leg.reentry_tsl_trail === 0 ?'' : (leg.reentry_tsl_trail !== undefined ? leg.reentry_tsl_trail :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_trail: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>

 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-rehigh-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close: e.target.checked, reentry_tsl_on_close_low: false, reentry_tsl_on_close_high: false })}
 />
 <Label htmlFor={`reentry-tsl-on-close-rehigh-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap">On Close</Label>
 </div>

 {leg.reentry_tsl_on_close && leg.side === 'SELL' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-low-rehigh-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_low || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_low: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-low-rehigh-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-pink-600">On Close Low</Label>
 </div>
 )}

 {leg.reentry_tsl_on_close && leg.side === 'BUY' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-high-rehigh-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_high || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_high: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-high-rehigh-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-emerald-600">On Close High</Label>
 </div>
 )}
 </div>
 )}
 </div>
 )}
 </div>
 </div>
 </div>
 )}

 {leg.relow_enabled && (
 <div className="space-y-2">
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
 <div className="space-y-1">
 <Label className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground block mb-1">RE LOW Mode</Label>
 <Select
 value={leg.relow_mode ||'RELOW_PLUS_PTS'}
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
 value={leg.relow_value === undefined || leg.relow_value ==='' ?'' : leg.relow_value}
 onChange={(e) => onChange({ ...leg, relow_value: e.target.value ==='' ?'' : parseFloat(e.target.value) })}
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
 {num} {num === 1 ?'Entry' :'Entries'}
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
 value={leg.relow_mntm_mode ||'RELOW_PLUS_PCT'}
 onValueChange={(v) => onChange({ ...leg, relow_mntm_mode: v })}
 >
 <SelectTrigger className="h-9 rounded-lg text-[10px]">
 <SelectValue placeholder="Mode" />
 </SelectTrigger>
 <SelectContent>
 <SelectItem value="RELOW_PLUS_PCT">RTP + %</SelectItem>
 <SelectItem value="RELOW_PLUS_PTS">RTP + Pts</SelectItem>
 <SelectItem value="RELOW_MINUS_PCT">RTP - %</SelectItem>
 <SelectItem value="RELOW_MINUS_PTS">RTP - Pts</SelectItem>
 </SelectContent>
 </Select>
 </div>
 <div className="space-y-1">
 <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground block mb-2">
 Value {leg.relow_mntm_mode && leg.relow_mntm_mode.includes('PCT') ?'(%)' :'(Pts)'}
 </Label>
 <Input
 className="h-9 rounded-lg text-[10px]"
 type="number"
 value={leg.relow_mntm_value === undefined ?'' : leg.relow_mntm_value}
 onChange={(e) => {
 const val = parseFloat(e.target.value);
 if (!isNaN(val) && val >= 0) {
 onChange({ ...leg, relow_mntm_value: val });
 } else if (e.target.value ==='') {
 onChange({ ...leg, relow_mntm_value:'' });
 }
 }}
 onBlur={(e) => {
 const val = parseFloat(e.target.value);
 if (isNaN(val)) {
 onChange({ ...leg, relow_mntm_value: 0 });
 }
 }}
 />
 </div>
 </div>
 )}

 <div className="w-full flex flex-col lg:flex-row items-start gap-2 lg:gap-4 pt-1">
 <div className="w-full lg:flex-1 space-y-1.5">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override SL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_sl_enabled || false}
 onCheckedChange={(val) => {
 const updatedLeg = { ...leg, reentry_sl_enabled: val };
 if (!val) updatedLeg.reentry_tsl_enabled = false;
 onChange(updatedLeg);
 }}
 />
 </div>
 {leg.reentry_sl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_sl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_sl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 value={leg.reentry_sl_value === 0 ?'' : (leg.reentry_sl_value !== undefined ? leg.reentry_sl_value :'')}
 placeholder={leg.stop_loss ||"0"}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_sl_value: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 </div>
 )}
 </div>

 {leg.reentry_sl_enabled && (
 <div className="w-full lg:flex-1 space-y-1.5 animate-in fade-in slide-in-from-left-2">
 <div className="flex items-center justify-between w-full lg:max-w-[280px]">
 <Label className="text-[10px] font-medium text-gray-700">Override TSL on Re-Entry</Label>
 <Switch
 checked={leg.reentry_tsl_enabled || false}
 onCheckedChange={(val) => onChange({ ...leg, reentry_tsl_enabled: val })}
 />
 </div>
 {leg.reentry_tsl_enabled && (
 <div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-1">
 <div className="flex-1 min-w-[100px] sm:min-w-[120px]">
 <Select
 value={leg.reentry_tsl_type ||'PERCENTAGE'}
 onValueChange={(v) => onChange({ ...leg, reentry_tsl_type: v })}
 >
 <SelectTrigger className="h-9 w-full rounded-lg text-[10px] bg-background border-input">
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
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Move"
 value={leg.reentry_tsl_move === 0 ?'' : (leg.reentry_tsl_move !== undefined ? leg.reentry_tsl_move :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_move: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>
 <div className="flex-1 min-w-[60px] sm:flex-none sm:w-[80px]">
 <Input
 className="h-9 w-full rounded-lg text-[10px] focus:ring-emerald-500"
 type="number"
 placeholder="Trail"
 value={leg.reentry_tsl_trail === 0 ?'' : (leg.reentry_tsl_trail !== undefined ? leg.reentry_tsl_trail :'')}
 onChange={(e) => {
 const val = e.target.value;
 onChange({ ...leg, reentry_tsl_trail: val ==='' ? 0 : parseFloat(val) });
 }}
 />
 </div>

 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-relow-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close: e.target.checked, reentry_tsl_on_close_low: false, reentry_tsl_on_close_high: false })}
 />
 <Label htmlFor={`reentry-tsl-on-close-relow-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap">On Close</Label>
 </div>

 {leg.reentry_tsl_on_close && leg.side === 'SELL' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-low-relow-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-pink-600 focus:ring-pink-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_low || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_low: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-low-relow-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-pink-600">On Close Low</Label>
 </div>
 )}

 {leg.reentry_tsl_on_close && leg.side === 'BUY' && (
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id={`reentry-tsl-on-close-high-relow-${idPrefix}`}
 className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
 checked={leg.reentry_tsl_on_close_high || false}
 onChange={(e) => onChange({ ...leg, reentry_tsl_on_close_high: e.target.checked })}
 />
 <Label htmlFor={`reentry-tsl-on-close-high-relow-${idPrefix}`} className="text-[10px] cursor-pointer whitespace-nowrap text-emerald-600">On Close High</Label>
 </div>
 )}
 </div>
 )}
 </div>
 )}
 </div>
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

 let timeString ='';
 if (hours > 0) timeString +=`${hours}h`;
 if (minutes > 0 || hours > 0) timeString +=`${minutes}m`;
 timeString +=`${seconds}s`;

 setTimeLeft(`in ${timeString.trim()}`);
 };

 updateTimer();
 const interval = setInterval(updateTimer, 1000);
 return () => clearInterval(interval);
 }, [entryTime]);

 return (
 <div className="flex items-center gap-1 px-1.5 py-0.5 ml-1 bg-indigo-50 text-indigo-700 font-medium rounded border border-indigo-100/60 animate-pulse">
 <Clock className="h-3 w-3" />
 <span className="text-[10px] tracking-wide uppercase">Entry at {entryTime} {timeLeft ?`(${timeLeft})` :''}</span>
 </div>
 );
};

// Tier 1 - Rule 1 & Phase 2: Interceptor to ensuring session key is always sent


export const StrategyFormContent = ({ config, setConfig, editingId, setEditingId, loading, handleSave, isReadOnly }) => {
 return (
 <div className={isReadOnly ?"read-only-form opacity-90" :""}>
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
 value={config.name ||''}
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
 <Select value={config.entry_limit_offset_type ||'POINTS'} onValueChange={(v) => setConfig({ ...config, entry_limit_offset_type: v })}>
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
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
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
 <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-300">
 <div className="flex items-center gap-2">
 <div className="flex flex-col gap-0.5 flex-1">
 <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Type</Label>
 <Select value={config.overall_sl_type ||'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_sl_type: v })}>
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
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
 setConfig({ ...config, overall_sl_value: val });
 }
 }}
 onBlur={(e) => {
 setConfig({ ...config, overall_sl_value: parseFloat(e.target.value) || 0 });
 }}
 />
 </div>
 </div>
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id="overall-sl-on-close"
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={config.overall_sl_on_close || false}
 onChange={(e) => setConfig({ ...config, overall_sl_on_close: e.target.checked })}
 />
 <Label htmlFor="overall-sl-on-close" className="text-[10px] cursor-pointer text-muted-foreground">On Close</Label>
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
 <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-300">
 <div className="flex items-center gap-2">
 <div className="flex flex-col gap-0.5 flex-1">
 <Label className="text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">Type</Label>
 <Select value={config.overall_target_type ||'PERCENTAGE'} onValueChange={(v) => setConfig({ ...config, overall_target_type: v })}>
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
 if (val ==='' || /^\d*\.?\d*$/.test(val)) {
 setConfig({ ...config, overall_target_value: val });
 }
 }}
 onBlur={(e) => {
 setConfig({ ...config, overall_target_value: parseFloat(e.target.value) || 0 });
 }}
 />
 </div>
 </div>
 <div className="flex items-center gap-1.5">
 <input
 type="checkbox"
 id="overall-target-on-close"
 className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
 checked={config.overall_target_on_close || false}
 onChange={(e) => setConfig({ ...config, overall_target_on_close: e.target.checked })}
 />
 <Label htmlFor="overall-target-on-close" className="text-[10px] cursor-pointer text-muted-foreground">On Close</Label>
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


 {config.ordertype !=='LIMIT' && (config.ordertype !=='MARKET' && config.ordertype !=='STOPLOSS_MARKET' && (
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

 {(config.ordertype ==='STOPLOSS_LIMIT' || config.ordertype ==='STOPLOSS_MARKET') && (
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


 <div className="flex items-end hide-on-readonly w-full md:w-auto mt-4 pt-4 border-t border-slate-100 md:border-none md:mt-0 md:pt-0">
 <Button
 className="w-full md:w-[150px] h-9 gap-2 rounded-lg font-medium text-[10px]"
 onClick={handleSave}
 disabled={loading}
 >
 {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
 {editingId ?"Update Strategy" :"Save Strategy"}
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

export const StrategyBuilder = ({ isConnected, onBacktestComplete }) => {
 const [loading, setLoading] = useState(false);
 const [runningStrategies, setRunningStrategies] = useState({}); // { id: data }
 const [savedStrategies, setSavedStrategies] = useState([]);
 const [folders, setFolders] = useState([]);
 const [editingId, setEditingId] = useState(null);
 const [activeTab, setActiveTab] = useState('live');
 const [logWindowOpen, setLogWindowOpen] = useState(false);
 const [logStrategyId, setLogStrategyId] = useState(null);
 const [configWindowOpen, setConfigWindowOpen] = useState(false);
 const [viewConfig, setViewConfig] = useState(null);
 const [viewStrategyName, setViewStrategyName] = useState('');
 const [searchTerm, setSearchTerm] = useState('');
 const [isConfigExpanded, setIsConfigExpanded] = useState(false);
 const [collapsedSections, setCollapsedSections] = useState({'saved-strategies': false });
 const [executionModalOpen, setExecutionModalOpen] = useState(false);
 const [selectedStrategyForExecution, setSelectedStrategyForExecution] = useState(null);

 const [backtestModalOpen, setBacktestModalOpen] = useState(false);
 const [selectedStrategyForBacktest, setSelectedStrategyForBacktest] = useState(null);
 const [selectedForCombined, setSelectedForCombined] = useState([]);
 const [deployModalOpen, setDeployModalOpen] = useState(false);
 const [selectedStrategyForDeploy, setSelectedStrategyForDeploy] = useState(null);
 const [folderModalOpen, setFolderModalOpen] = useState(false);
 const [folderModalData, setFolderModalData] = useState(null);
 const [folderNameInput, setFolderNameInput] = useState('');
 const [moveStrategiesModalOpen, setMoveStrategiesModalOpen] = useState(false);
 const [moveTargetFolderId, setMoveTargetFolderId] = useState(null);
 const [availableDates, setAvailableDates] = useState([]);
 const [dateRange, setDateRange] = useState({ from: null, to: null });
 const [activeDateInput, setActiveDateInput] = useState('from');
 const [loadingDates, setLoadingDates] = useState(false);
 const [isBacktesting, setIsBacktesting] = useState(false);
 const [activeMenuId, setActiveMenuId] = useState(null);

 useEffect(() => {
   const handleClickOutside = () => {
     if (activeMenuId) setActiveMenuId(null);
   };
   document.addEventListener('click', handleClickOutside);
   return () => document.removeEventListener('click', handleClickOutside);
 }, [activeMenuId]);

 const fileInputRef = useRef(null);

 const handleDownloadStrategy = (strategy) => {
 const exportData = {
 ...strategy.config,
 name: strategy.name || strategy.config?.name || 'Exported Strategy'
 };
 delete exportData.id;
 delete exportData.user_id;

 const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
 const url = URL.createObjectURL(blob);
 const downloadAnchorNode = document.createElement('a');
 downloadAnchorNode.setAttribute("href", url);
 downloadAnchorNode.setAttribute("download", `${exportData.name}.json`);
 document.body.appendChild(downloadAnchorNode);
 downloadAnchorNode.click();
 document.body.removeChild(downloadAnchorNode);
 URL.revokeObjectURL(url);
 };

 const handleDownloadPdfDirect = async (strategy) => {
    try {
      window.__pdfExportConfig = strategy.config;
      const name = strategy.name || strategy.config?.name || 'Strategy';
      await downloadElementAsPdf(null, name);
    } catch (err) {
      console.error('Failed to download PDF:', err);
    } finally {
      delete window.__pdfExportConfig;
    }
  };

 const handleUploadClick = () => {
 if (fileInputRef.current) {
 fileInputRef.current.click();
 }
 };

 const handleFileChange = async (e) => {
 const file = e.target.files[0];
 if (!file) return;

 const reader = new FileReader();
 reader.onload = async (event) => {
 try {
 const uploadedConfig = JSON.parse(event.target.result);
 delete uploadedConfig.id;
 delete uploadedConfig.user_id;

 let baseName = uploadedConfig.name || "Imported Strategy";
 let finalName = baseName;
 let counter = 1;
 while(savedStrategies.find(s => s.name.trim().toLowerCase() === finalName.trim().toLowerCase())) {
 finalName = `${baseName} (${counter})`;
 counter++;
 }
 uploadedConfig.name = finalName;

 const finalConfig = {
 ...uploadedConfig,
 variety: 'STOPLOSS',
 producttype: 'CARRYFORWARD',
 ordertype: 'LIMIT',
 duration: 'DAY'
 };

 setLoading(true);
 await axios.post(`${API_BASE_URL}/strategy/save`, finalConfig);
 fetchSavedStrategies();
 } catch (err) {
 alert("Error importing strategy: " + (err.response?.data?.message || err.message || "Invalid JSON"));
 } finally {
 setLoading(false);
 e.target.value = ''; // Reset input
 }
 };
 reader.readAsText(file);
 };

 useEffect(() => {
 if (selectedStrategyForBacktest) {
 const stratIdKey = Array.isArray(selectedStrategyForBacktest)
 ? selectedStrategyForBacktest.map(s => s.id).sort().join('_')
 : selectedStrategyForBacktest.id;
 const saved = localStorage.getItem(`backtest_dates_${stratIdKey}`);
 if (saved) {
 try {
 const parsed = JSON.parse(saved);
 if (parsed.from && parsed.to) {
 setDateRange(parsed);
 return;
 }
 } catch (e) {
 // Ignore parsing error
 }
 }
 setDateRange({ from: null, to: null });
 }
 }, [selectedStrategyForBacktest]);

 const handleDateSelect = (dateString) => {
 setDateRange(prev => {
 if (activeDateInput ==='from') {
 return { ...prev, from: dateString };
 } else {
 return { ...prev, to: dateString };
 }
 });
 if (activeDateInput ==='from') setActiveDateInput('to');
 };

 const fetchDates = async (index) => {
 setLoadingDates(true);
 try {
 const res = await fetchBacktestDates(index);
 if (res.success) {
 setAvailableDates(res.data);
 }
 } catch (e) {
 console.error("Failed to fetch dates", e);
 } finally {
 setLoadingDates(false);
 }
 };

 const [config, setConfig] = useState({
 name:'',
 index:'NIFTY',
 entry_time:'09:16:00',
 exit_time:'15:29:00',
 variety:'STOPLOSS',
 ordertype:'LIMIT',
 producttype:'CARRYFORWARD',
 duration:'DAY',
 price:'0',
 triggerprice:'0',
 squareoff:'0',
 stoploss:'0',
 overall_sl_type:'PERCENTAGE',
 overall_sl_value: 0,
 overall_sl_enabled: false,
 overall_sl_on_close: false,
 overall_target_type:'PERCENTAGE',
 overall_target_value: 0,
 overall_target_enabled: false,
 overall_target_on_close: false,
 entry_limit_offset: 0,
 entry_limit_offset_type:'POINTS',
 chase_time_seconds: 45,
 quantity_multiplier: 1,
 legs: [
 { strike_criteria:'STRIKE_TYPE', option_type:'CE', strike:'ATM', premium: 0, side:'BUY', lots: 1, sl_type:'PERCENTAGE', stop_loss: 10, simple_mntm_enabled: false, simple_mntm_mode:'SIMPLE_PLUS_PCT', simple_mntm_value: 0, recost_enabled: false, recost_mode:'RECOST_PLUS_PCT', recost_value: 0, max_reentry: 1, no_reentry_on_sl_candle: false, reentry_sl_enabled: false, reentry_sl_type:'PERCENTAGE', reentry_sl_value: 10, reentry_tsl_enabled: false, reentry_tsl_type:'PERCENTAGE', reentry_tsl_move: 0, reentry_tsl_trail: 0, re_asap_enabled: false, re_asap_max_entries: 1, lazy_leg_enabled: false, lazy_leg: null, tsl_enabled: false, tsl_type:'PERCENTAGE', tsl_move: 0 }
 ]
 });

 const fetchSavedStrategies = async () => {
 try {
 const res = await axios.get(`${API_BASE_URL}/strategy/user`);
 let fetchedData = res.data?.data || [];

 // Client-side ordering
 const savedOrder = JSON.parse(localStorage.getItem('custom_strategy_order') ||'[]');
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

 const fetchFolders = async () => {
 try {
 const res = await axios.get(`${API_BASE_URL}/folders`);
 setFolders(res.data?.data || []);
 } catch (err) {
 console.error("Error fetching folders:", err);
 }
 };

 const handleCreateFolder = (parentId = null) => {
 setFolderModalData({ mode: 'create', parent_id: parentId });
 setFolderNameInput('');
 setFolderModalOpen(true);
 };

 const handleRenameFolder = (folder) => {
 setFolderModalData({ mode: 'rename', folder });
 setFolderNameInput(folder.name);
 setFolderModalOpen(true);
 };

 const submitFolderModal = async () => {
 const name = folderNameInput.trim();
 if (!name) return;
 
 try {
 if (folderModalData?.mode === 'create') {
 await axios.post(`${API_BASE_URL}/folders`, { name, parent_id: folderModalData.parent_id });
 } else if (folderModalData?.mode === 'rename' && folderModalData.folder) {
 if (name === folderModalData.folder.name) {
 setFolderModalOpen(false);
 return;
 }
 await axios.put(`${API_BASE_URL}/folders/${folderModalData.folder.id}`, { 
 name, 
 parent_id: folderModalData.folder.parent_id 
 });
 }
 fetchFolders();
 setFolderModalOpen(false);
 } catch (err) {
 alert(err.response?.data?.message || "Failed to save folder");
 }
 };

 const handleDeleteFolder = async (folderId) => {
 if (!window.confirm("Are you sure you want to delete this folder? Strategies inside will be moved to the root.")) return;
 try {
 await axios.delete(`${API_BASE_URL}/folders/${folderId}`);
 fetchFolders();
 fetchSavedStrategies();
 } catch (err) {
 alert(err.response?.data?.message || "Failed to delete folder");
 }
 };

 const handleMoveStrategy = async (strategyId, folderId) => {
 try {
 await axios.patch(`${API_BASE_URL}/strategy/move/${strategyId}`, { folder_id: folderId });
 fetchSavedStrategies();
 } catch (err) {
 alert(err.response?.data?.message || "Failed to move strategy");
 }
 };

 const handleMoveMultipleStrategies = async () => {
 try {
 await axios.patch(`${API_BASE_URL}/strategy/move-multiple`, {
 strategy_ids: selectedForCombined,
 folder_id: moveTargetFolderId
 });
 fetchSavedStrategies();
 setMoveStrategiesModalOpen(false);
 setSelectedForCombined([]); // clear selection
 setMoveTargetFolderId(null);
 } catch (err) {
 alert(err.response?.data?.message || "Failed to move strategies");
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
 fetchFolders();
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
 alert(`A strategy named"${config.name}" already exists. Please choose a different name.`);
 return;
 }
 }

 setLoading(true);
 const finalConfig = {
 ...config,
 variety:'STOPLOSS',
 producttype:'CARRYFORWARD',
 ordertype:'LIMIT',
 duration:'DAY'
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
 const errorMsg = validationErrors.map(e =>`${e.path}: ${e.msg}`).join('\n');
 alert("Validation Error:\n" + errorMsg);
 } else {
 alert("Error saving strategy:" + (err.response?.data?.message || err.message));
 }
 } finally {
 setLoading(false);
 }
 };

 const handleExecutionSettingsSave = async (id, settings) => {
 try {
 await axios.patch(`${API_BASE_URL}/strategy/settings/${id}`, settings);
 fetchSavedStrategies();
 } catch (err) {
 console.error("Error updating execution settings:", err);
 alert("Failed to update execution settings");
 }
 };

 const handleExecute = async (id, mode) => {
 if (!isConnected) {
 alert("Please connect to Angel One to execute strategies.");
 return;
 }
 let isVirtual = false;
 let isPaper = false;

 if (mode === 'paper' || mode === true) {
 isVirtual = false;
 isPaper = true;
 } else if (mode === 'live' || mode === false) {
 isVirtual = false;
 isPaper = false;
 }

 try {
 const res = await axios.post(`${API_BASE_URL}/strategy/execute/${id}`, {
 is_paper_trading: isPaper,
 is_virtual: isVirtual,
 mode: mode
 });
 const newId = res.data.strategy_id || res.data.execution_id;
 // Fetch initial status
 const statusRes = await axios.get(`${API_BASE_URL}/strategy/status/${newId}`);
 setRunningStrategies(prev => ({
 ...prev,
 [newId]: statusRes.data.data
 }));

 if (isPaper) setActiveTab('paper');
 else setActiveTab('live');

 fetchActive();
 } catch (err) {
 alert("Error executing strategy:" + err.message);
 }
 };

 const handleStop = async (id) => {
 if (!id) return;
 try {
 setRunningStrategies(prev => {
 const next = { ...prev };
 if (next[id]) next[id] = { ...next[id], status:'STOPPED' };
 return next;
 });
 await axios.post(`${API_BASE_URL}/strategy/stop/${id}`);
 } catch (err) {
 alert("Error stopping strategy:" + err.message);
 fetchActive(); // Revert optimistic update on error
 }
 };

 const handleMoveToHistory = async (id) => {
 if (!id) return;
 if (!confirm("Are you sure you want to permanently move this strategy to history?")) return;
 try {
 setRunningStrategies(prev => {
 const next = { ...prev };
 delete next[id];
 return next;
 });
 await axios.post(`${API_BASE_URL}/strategy/movetohistory/${id}`);
 } catch (err) {
 alert("Error moving strategy to history:" + err.message);
 fetchActive(); // Revert optimistic update on error
 }
 };

 const handleSquareOff = async (id) => {
 if (!id) return;
 if (!confirm("Are you sure you want to instantly square off all positions for this strategy?")) return;
 try {
 setRunningStrategies(prev => {
 const next = { ...prev };
 if (next[id]) next[id] = { ...next[id], status:'SQUARED_OFF' };
 return next;
 });
 await axios.post(`${API_BASE_URL}/strategy/squareoff/${id}`);
 } catch (err) {
 alert("Error squaring off strategy:" + (err.response?.data?.message || err.message));
 fetchActive(); // Revert optimistic update on error
 }
 };

 const handleSwitchVirtual = async (id, targetVirtual) => {
 if (!id) return;
 const actionText = targetVirtual 
 ? "switch this strategy to VIRTUAL mode? Open positions will be exited while background virtual monitoring continues." 
 : "switch this strategy back from VIRTUAL mode? Active legs will be re-entered at current market prices.";
 if (!confirm(`Are you sure you want to ${actionText}`)) return;
 try {
 setRunningStrategies(prev => {
 const next = { ...prev };
 if (next[id]) next[id] = { ...next[id], is_virtual: targetVirtual };
 return next;
 });
 await axios.post(`${API_BASE_URL}/strategy/switch-virtual/${id}`, { is_virtual: targetVirtual });
 fetchActive();
 } catch (err) {
 alert("Error switching virtual mode:" + (err.response?.data?.message || err.message));
 fetchActive();
 }
 };


 const handleSquareOffLeg = async (id, legIndex) => {
 if (!id) return;
 if (!confirm("Are you sure you want to instantly square off this specific leg?")) return;
 try {
 await axios.post(`${API_BASE_URL}/strategy/squareoff/${id}/leg/${legIndex}`);
 // Fetch directly from in-memory status to get fresh leg data, avoiding DB stale read
 const res = await axios.get(`${API_BASE_URL}/strategy/status/${id}`);
 setRunningStrategies(prev => ({
 ...prev,
 [id]: res.data.data
 }));
 } catch (err) {
 alert("Error squaring off leg:" + err.response?.data?.message || err.message);
 }
 };

 const handleResume = async (id) => {
 if (!id) return;
 if (!confirm("Resume this PAUSED strategy? Monitoring will restart.")) return;
 try {
 await axios.post(`${API_BASE_URL}/strategy/resume/${id}`);
 const res = await axios.get(`${API_BASE_URL}/strategy/status/${id}`);
 setRunningStrategies(prev => ({
 ...prev,
 [id]: res.data.data
 }));
 } catch (err) {
 alert("Error resuming strategy:" + err.response?.data?.message || err.message);
 }
 };

 const handleEdit = (strategy) => {
 const conf = strategy.config;
 setConfig({
 ...conf,
 variety:'STOPLOSS',
 producttype:'CARRYFORWARD',
 ordertype:'LIMIT',
 duration:'DAY',
 overall_sl_enabled: conf.overall_sl_enabled ?? (conf.overall_sl_value > 0),
 overall_target_enabled: conf.overall_target_enabled ?? (conf.overall_target_value > 0)
 });
 setEditingId(strategy.id);
 setIsConfigExpanded(true);
 window.scrollTo({ top: 0, behavior:'smooth' });
 };

 const handleDelete = async (strategyIdToDelete) => {
 if (!confirm("Delete this strategy?")) return;
 try {
 await axios.delete(`${API_BASE_URL}/strategy/delete/${strategyIdToDelete}`);
 fetchSavedStrategies();
 } catch (err) {
 alert("Error deleting strategy:" + err.message);
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
 const side = l.leg?.side ||"SELL";
 const pnlPoints = side ==="BUY" ? (curLtp - entry) : (entry - curLtp);
 const multiplier = parseFloat(strategy.config?.quantity_multiplier) || 1;
 const quantity = (l.leg?.lots || 0) * (parseInt(l.instrument?.lotsize) || 1) * multiplier;

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
  const calculatedOriginalValue = updatedLegs.reduce((sum, l) => {
    const price = l.original_traded_price || l.entryPrice || 0;
    if (!price) return sum;
    const multiplier = parseFloat(strategy.config?.quantity_multiplier) || 1;
    const quantity = (l.leg?.lots || 0) * (parseInt(l.instrument?.lotsize) || 1) * multiplier;
    return sum + (price * quantity);
  }, 0);

  const totalOriginalValue = calculatedOriginalValue || strategy.totalOriginalValue || 0;
  const finalPnlRupees = totalPnlRupees || strategy.totalPnlRupees || 0;
  const avgPnl = totalOriginalValue > 0 ? (finalPnlRupees / totalOriginalValue) * 100 : (strategy.pnlPercent || 0);

  return {
    ...strategy,
    legs: updatedLegs,
    totalPnlRupees: finalPnlRupees,
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
 if (leg.instrument?.token === data.token &&
 (leg.instrument?.exch_seg === data.exchange || leg.instrument?.exchange === data.exchange)) {
 // Do NOT update LTP for exited legs that are not waiting for re-entry
 if (leg.exited && !REENTRY_WAITING_STATES.includes(leg.state)) {
 return leg;
 }
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
 // Trigger an immediate fetch to reflect the log's associated state change instantly
 axios.get(`${API_BASE_URL}/strategy/status/${data.strategyId}`).then(res => {
 setRunningStrategies(prev => {
 if (!prev[data.strategyId]) return prev;
 const latestData = res.data.data;
 const currentStrategy = prev[data.strategyId];
 // Keep local logs since we just updated them above
 return {
 ...prev,
 [data.strategyId]: { 
 ...latestData,
 logs: currentStrategy.logs
 }
 };
 });
 }).catch(e => console.error("Instant state sync failed on log:", e));
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
  if (u.error) {
  // Skip on error, don't automatically delete or move to history
  return;
  }

  // EXITED is an active-but-done state — keep it in the panel (grayed out)
  // Only truly terminal states (swept by server or moved manually) get removed
  const isFullyDone = u.data?.status && ["COMPLETED","FAILED","TERMINATED","STOPPED","CANCELLED","SQUARED_OFF"].includes(u.data.status);

  if (isFullyDone) {
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
    legs: latestLegs.map((newLeg, idx) => {
      const existingLeg = existing.legs?.find(ex => 
          (ex.uniqueOrderId && newLeg.uniqueOrderId && ex.uniqueOrderId === newLeg.uniqueOrderId) ||
          (ex.instrument?.token === newLeg.instrument?.token && !!ex.is_virtual_monitoring === !!newLeg.is_virtual_monitoring && !!ex.is_virtual_leg === !!newLeg.is_virtual_leg && ex.legIndex === newLeg.legIndex)
      ) || existing.legs?.[idx];
      const isClosedLeg = newLeg.exited && !REENTRY_WAITING_STATES.includes(newLeg.state);
      const fixedLtp = newLeg.exitSnapshot?.exitLtp || newLeg.currentLtp;
      // Only carry over existingLeg's LTP if that existing leg is itself live (not frozen/exited).
      // This prevents a previously-exited leg's frozen exit price from bleeding into a waiting leg that shares the same legIndex/token.
      const existingIsLive = existingLeg && !(existingLeg.exited && !REENTRY_WAITING_STATES.includes(existingLeg.state));
      return {
        ...newLeg,
        currentLtp: isClosedLeg ? (fixedLtp || 0) : (existingIsLive ? (existingLeg.currentLtp || newLeg.currentLtp) : newLeg.currentLtp)
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

 // Intentionally removed fetchActive() to prevent bringing deleted/ghost strategies back to UI
 } catch (err) {
 console.error("Error polling statuses:", err);
 }
 }, 2000); // Polling every 2s for reliable status sync
 }
 return () => clearInterval(interval);
 }, [Object.keys(runningStrategies).length, isConnected]);

  const filteredRunningStrategies = Object.entries(runningStrategies).filter(([_, strategyData]) => {
    const isPaper = !!strategyData.config?.is_paper_trading;
    return activeTab === 'paper' ? isPaper : !isPaper;
  });

  const cumulativeActivePnl = filteredRunningStrategies.reduce((sum, [_, s]) => sum + (Number(s.totalPnlRupees) || 0), 0);
  const cumulativeActiveValue = filteredRunningStrategies.reduce((sum, [_, s]) => sum + (Number(s.totalOriginalValue) || 0), 0);
  const cumulativeActivePnlPercent = cumulativeActiveValue > 0 ? (cumulativeActivePnl / cumulativeActiveValue) * 100 : 0;

  // Update browser tab title with live overall PnL (live trading only)
  useEffect(() => {
     if (activeTab !== 'live') {
       document.title = 'Corequant';
       return;
     }
    if (filteredRunningStrategies.length > 0) {
      const sign = cumulativeActivePnl >= 0 ? '+' : '';
      const pnlStr = `${sign}₹${cumulativeActivePnl.toFixed(0)}`;
      document.title = `${pnlStr} | Live Trading - Corequant`;
    } else {
      document.title = 'Live Trading - Corequant';
    }
    return () => {
      document.title = 'Corequant';
    };
  }, [cumulativeActivePnl, filteredRunningStrategies.length, activeTab]);

  const renderStrategyRow = (s, level = 0) => (
 <div
 key={s.id}
 className="grid grid-cols-1 xl:grid-cols-12 gap-2 xl:gap-4 px-4 py-3 xl:items-center hover:bg-muted/50 transition-colors cursor-grab active:cursor-grabbing bg-card mobile-strategy-row"
 style={{ paddingLeft: `${Math.min(level, 4) * 12 + 16}px` }}
 draggable
 onDragStart={(e) => {
 e.dataTransfer.effectAllowed ='move';
 e.dataTransfer.setData('text/plain', s.id);
 setTimeout(() => { if (e.target && e.target.classList) e.target.classList.add('opacity-40'); }, 0);
 }}
 onDragEnd={(e) => {
 if (e.target && e.target.classList) {
 e.target.classList.remove('opacity-40');
 e.target.classList.remove('border-t-2','border-b-2','border-primary','bg-muted/30');
 }
 }}
 onDragOver={(e) => {
 e.preventDefault();
 e.dataTransfer.dropEffect ='move';
 if (e.currentTarget) {
 const rect = e.currentTarget.getBoundingClientRect();
 const isTopHalf = e.clientY < rect.top + rect.height / 2;
 e.currentTarget.classList.remove('border-t-2','border-b-2','border-primary');
 e.currentTarget.classList.add(isTopHalf ?'border-t-2' :'border-b-2','border-primary');
 }
 }}
 onDragEnter={(e) => {
 e.preventDefault();
 if (e.currentTarget && e.currentTarget.classList) e.currentTarget.classList.add('bg-muted/30');
 }}
 onDragLeave={(e) => {
 if (e.currentTarget && e.currentTarget.classList) {
 e.currentTarget.classList.remove('bg-muted/30','border-t-2','border-b-2','border-primary');
 }
 }}
 onDrop={(e) => {
 e.preventDefault();
 if (e.currentTarget && e.currentTarget.classList) {
 e.currentTarget.classList.remove('bg-muted/30','border-t-2','border-b-2','border-primary');
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
 <div className="col-span-1 xl:col-span-3 flex flex-col xl:flex-row gap-2 xl:gap-2">
 <div className="flex xl:hidden items-center justify-between" onClick={(e) => e.stopPropagation()}>
 <span className="text-[10px] uppercase font-medium text-black tracking-wider">Combine</span>
 <input
 type="checkbox"
 className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
 checked={selectedForCombined.includes(s.id)}
 onChange={(e) => {
 if (e.target.checked) {
 setSelectedForCombined(prev => [...prev, s.id]);
 } else {
 setSelectedForCombined(prev => prev.filter(id => id !== s.id));
 }
 }}
 />
 </div>
 <div className="font-medium text-[12px] flex items-start xl:items-center gap-2">
 <div className="hidden xl:flex items-center h-full mr-1" onClick={(e) => e.stopPropagation()}>
 <input
 type="checkbox"
 className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
 checked={selectedForCombined.includes(s.id)}
 onChange={(e) => {
 if (e.target.checked) {
 setSelectedForCombined(prev => [...prev, s.id]);
 } else {
 setSelectedForCombined(prev => prev.filter(id => id !== s.id));
 }
 }}
 />
 </div>
 <div className="p-1 rounded text-black hover:text-black transition-colors mt-0.5 xl:mt-0 cursor-grab">
 <GripVertical className="h-4 w-4 shrink-0" />
 </div>
 <div>
 {s.name || s.config?.name ||'Unnamed Strategy'}
 <div className="text-[9px] font-mono text-black font-normal mt-0.5">ID: {s.id.split('-')[0] || s.id}</div>
 </div>
 </div>
 </div>
 <div className="col-span-1 xl:col-span-2 font-mono text-[11px] xl:text-[10px] text-black xl:text-black flex xl:block items-center justify-between">
 <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider">Created</span>
 <span>{new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</span>
 </div>
 <div className="col-span-1 xl:col-span-1 font-medium text-[12px] xl:text-[10px] flex xl:block items-center justify-between">
 <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider">Index</span>
 <span>{s.config?.index}</span>
 </div>
 <div className="col-span-1 xl:col-span-2 flex xl:block items-center justify-between">
 <span className="xl:hidden text-[10px] uppercase font-medium text-black tracking-wider pr-4">Type</span>
 <div className="flex flex-wrap items-center gap-1">
 <span className="px-1.5 py-0.5 rounded text-[10px] xl:text-[9px] font-medium bg-slate-100 text-black text-right xl:text-left line-clamp-2">
 {s.config?.legs?.map((l) =>`${l.side} ${l.option_type} (${l.lots * (s.config?.quantity_multiplier || 1)}L)`).join(' |') ||'---'}
 </span>
 {s.config?.quantity_multiplier > 1 && (
 <span className="px-1.5 py-0.5 rounded text-[10px] xl:text-[9px] font-black bg-indigo-100 text-indigo-700 border border-indigo-200">
 x{s.config.quantity_multiplier}
 </span>
 )}
 {(() => {
 const activeExecs = Object.values(runningStrategies).filter(exec => exec.strategy_id === s.id && exec.status !=='TERMINATED' && exec.status !=='FAILED');
 const paperCount = activeExecs.filter(e => e.config?.is_paper_trading).length;
 const liveCount = activeExecs.filter(e => !e.config?.is_paper_trading).length;

 return (
 <>
 {paperCount > 0 && (
 <span className="px-1.5 py-0.5 rounded text-[10px] xl:text-[9px] font-black bg-blue-100 text-blue-700 border border-blue-200">
 {paperCount} Paper
 </span>
 )}
 {liveCount > 0 && (
 <span className="px-1.5 py-0.5 rounded text-[10px] xl:text-[9px] font-black bg-orange-100 text-orange-700 border border-orange-200">
 {liveCount} Live
 </span>
 )}
 </>
 );
 })()}
 </div>
 </div>
 <div className="col-span-1 xl:col-span-4 text-right mt-2 xl:mt-0 pt-3 xl:pt-0 border-t border-dashed border-gray-100 xl:border-none">
 <div className="flex flex-nowrap items-center justify-start gap-1 w-fit ml-0 xl:ml-auto">
 <Button
 size="sm"
 variant="outline"
 className="h-8 xl:h-7 px-2 rounded-md text-[11px] xl:text-[10px] flex-1 xl:flex-none border-indigo-200 bg-indigo-50/50 text-indigo-700 hover:bg-indigo-100 gap-1 font-bold"
 onClick={() => {
 setSelectedStrategyForExecution(s);
 setExecutionModalOpen(true);
 }}
 title="Execution Settings"
 >
 <Sliders className="h-3 w-3" /> Settings
 </Button>
 <Button
 size="sm"
 variant="outline"
 className="h-8 xl:h-7 px-2 rounded-md text-[11px] xl:text-[10px] flex-1 xl:flex-none border-cyan-200 bg-cyan-50/50 text-cyan-700 hover:bg-cyan-100 gap-1 font-bold"
 onClick={() => {
 setSelectedStrategyForBacktest(s);
 setBacktestModalOpen(true);
 if (s.config?.backtest_from_date && s.config?.backtest_to_date) {
 setDateRange({ from: s.config.backtest_from_date, to: s.config.backtest_to_date });
 } else {
 setDateRange({ from: null, to: null });
 }
 fetchDates(s.config?.index ||'NIFTY');
 }}
 title="Run Backtest"
 >
 <Database className="h-3 w-3" /> Backtest
 </Button>
 <Button
 size="sm"
 className={`h-8 xl:h-7 px-2 gap-1 rounded-md text-[11px] xl:text-[10px] font-medium flex-1 xl:flex-none ${!isConnected ?'opacity-50 grayscale cursor-not-allowed' :''}`}
 onClick={() => {
 setSelectedStrategyForDeploy(s);
 setDeployModalOpen(true);
 }}
 disabled={!isConnected}
 title={!isConnected ?"Please connect to Angel One to execute strategies" :""}
 >
 <Play className="h-3 w-3 fill-current" /> Deploy
 </Button>
 <Button
 size="sm"
 variant="outline"
 className="h-8 xl:h-7 px-2 gap-1 rounded-md text-[11px] xl:text-[10px] font-medium border-slate-200 hover:bg-slate-50 text-slate-600 flex-1 xl:flex-none"
 onClick={() => {
 setViewConfig(s.config);
 setViewStrategyName(s.name || s.config?.name ||'Strategy');
 setConfigWindowOpen(true);
 }}
 >
 <Eye className="h-3 w-3" /> View
 </Button>
 <Button
 size="sm"
 variant="outline"
 className="h-8 xl:h-7 px-2 rounded-md text-[11px] xl:text-[10px] flex-1 xl:flex-none"
 onClick={() => handleEdit(s)}
 >
 Edit
 </Button>
 <div className="relative">
   <Button
     size="sm"
     variant="ghost"
     className="h-8 xl:h-7 w-8 xl:w-7 p-0 rounded-md text-slate-500 hover:bg-slate-100 flex-none"
     onClick={(e) => {
       e.stopPropagation();
       setActiveMenuId(activeMenuId === s.id ? null : s.id);
     }}
   >
     <MoreVertical className="h-4 w-4" />
   </Button>
   {activeMenuId === s.id && (
     <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-slate-200 shadow-xl rounded-md z-[100] flex flex-col py-1 overflow-hidden" onClick={(e) => e.stopPropagation()}>
       <button
         className="w-full text-left px-3 py-2 text-[11px] font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-2"
         onClick={() => { handleDownloadStrategy(s); setActiveMenuId(null); }}
       >
         <Download className="h-3 w-3" /> JSON
       </button>
       <button
         className="w-full text-left px-3 py-2 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50 flex items-center gap-2"
         onClick={() => { handleDownloadPdfDirect(s); setActiveMenuId(null); }}
       >
         <FileText className="h-3 w-3" /> PDF
       </button>
       <div className="h-px bg-slate-100 my-1 w-full" />
       <button
         className="w-full text-left px-3 py-2 text-[11px] font-medium text-red-600 hover:bg-red-50 flex items-center gap-2"
         onClick={() => { handleDelete(s.id); setActiveMenuId(null); }}
       >
         <Trash2 className="h-3 w-3" /> Delete
       </button>
     </div>
   )}
 </div>
 </div>
 </div>
 </div>
  );

 return (
 <div className="space-y-4">
 <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".json" onChange={handleFileChange} />
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
 <div className="flex items-center gap-2">

 <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0">
 {isConfigExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
 </Button>
 </div>
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
 onClick={() => setCollapsedSections(prev => ({ ...prev,'active-strategies': !prev['active-strategies'] }))}
 >
 <CardTitle className="flex items-center gap-2 text-[11px] font-medium">
 <Play className="h-4 w-4 text-primary" /> Active Executions
 </CardTitle>
 <div className="flex items-center gap-4">
 {filteredRunningStrategies.length > 0 && (
 <div className="flex items-center gap-2">
 <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Overall PnL:</span>
 <span className={`text-[12px] font-mono font-bold px-2 py-0.5 rounded border ${cumulativeActivePnl >= 0 ?'bg-emerald-50 text-emerald-700 border-emerald-200' :'bg-red-50 text-red-700 border-red-200'}`}>
 {cumulativeActivePnl > 0 ?'+' :''}{cumulativeActivePnlPercent.toFixed(2)}% | {cumulativeActivePnl > 0 ?'+' :''}₹{cumulativeActivePnl.toFixed(0)}
 </span>
 </div>
 )}
 <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
 {collapsedSections['active-strategies'] ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
 </Button>
 </div>
 </div>
 </Card>
 {!collapsedSections['active-strategies'] && (
 <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
 {Object.entries(runningStrategies)
 .filter(([_, strategyData]) => {
 const isPaper = !!strategyData.config?.is_paper_trading;
 return activeTab ==='paper' ? isPaper : !isPaper;
 })
 .map(([id, strategyData]) => {
  const isTerminal = ["COMPLETED","FAILED","TERMINATED","STOPPED","CANCELLED","SQUARED_OFF","EXITED"].includes(strategyData.status);
 return (
 <Card key={id} className={`w-full border-border animate-in fade-in slide-in-from-bottom-4 duration-500 ${strategyData.config?.is_paper_trading ?'bg-blue-50/50' :'bg-orange-50/50'} ${strategyData.status ==='EXITED' ?'opacity-80 grayscale' :''}`}>
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
 <span className="relative flex h-2 w-2">
  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${strategyData.status === 'FAILED' ? 'bg-red-400' : strategyData.status === 'PAUSED' ? 'bg-amber-400' : strategyData.status === 'EXITED' ? 'bg-slate-300' : 'bg-green-400'} opacity-75`}></span>
  <span className={`relative inline-flex rounded-full h-2 w-2 ${strategyData.status === 'FAILED' ? 'bg-red-500' : strategyData.status === 'PAUSED' ? 'bg-amber-500' : strategyData.status === 'EXITED' ? 'bg-slate-400' : 'bg-green-500'}`}></span>
 </span>

 <span className="text-xs font-bold text-black">
 {strategyData.name || strategyData.config?.name ||'Strategy Execution'}
 <span className="text-[10px] font-mono text-black/60 ml-1.5">#{id.split('-')[0] || id}</span>
 </span>

 <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase ${strategyData.is_virtual ? 'bg-purple-100/80 text-purple-700 border border-purple-200' : strategyData.config?.is_paper_trading ?'bg-blue-100/80 text-blue-700 border border-blue-200' :'bg-orange-100/80 text-orange-700 border border-orange-200'}`}>
 {strategyData.status} • {strategyData.is_virtual ? 'VIRTUAL (MONITORING)' : (strategyData.config?.is_paper_trading ?'PAPER' :'LIVE')} • {strategyData.config?.index}
 </span>

 {strategyData.config?.quantity_multiplier > 1 && (
 <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase bg-indigo-100/80 text-indigo-700 border border-indigo-200">
 {strategyData.config.quantity_multiplier}x QTY
 </span>
 )}

 {strategyData.config?.exit_time && (
 <span className="text-[9px] font-black px-1.5 py-0.5 rounded uppercase bg-slate-100/80 text-slate-700 border border-slate-200 flex items-center gap-1">
 <Clock className="h-2.5 w-2.5" /> Exit: {strategyData.config.exit_time}
 </span>
 )}

 {strategyData.status ==='WAITING' && strategyData.config?.entry_time && (
 <EntryTimer entryTime={strategyData.config.entry_time} />
 )}

 {(strategyData?.status ==="IN_POSITION" || strategyData?.status ==="COMPLETED" || strategyData?.status ==="EXITED") && (
  <div className="flex items-center gap-1.5 ml-1 flex-wrap">
  {(() => {
  const isVirtualLeg = l => l.is_virtual_leg || l.is_virtual_monitoring;

  const bookedRupees = (strategyData.legs || [])
    .filter(l => l.exited && !isVirtualLeg(l))
    .reduce((sum, l) => sum + (l.pnlRupees || l.bookedPnlRupees || 0), 0);

  const activeVirtualRupees = (strategyData.legs || [])
    .filter(l => isVirtualLeg(l))
    .reduce((sum, l) => sum + (l.exited ? (l.pnlRupees || l.bookedPnlRupees || 0) : (l.currentActivePnlRupees || l.pnlRupees || 0)), 0);

  const hasVirtualLegs = (strategyData.legs || []).some(l => isVirtualLeg(l));
  const totalRupees = Number(strategyData.totalPnlRupees) || (bookedRupees + activeVirtualRupees);

  return (
  <>
  {bookedRupees !== 0 && (
  <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border ${bookedRupees >= 0 ?'bg-emerald-50 text-emerald-700 border-emerald-200' :'bg-red-50 text-red-700 border-red-200'}`}>
  Booked: {bookedRupees > 0 ?'+' :''}₹{bookedRupees.toFixed(0)}
  </span>
  )}
  {hasVirtualLegs && (
  <span className={`text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border ${activeVirtualRupees >= 0 ?'bg-purple-50 text-purple-700 border-purple-200' :'bg-pink-50 text-pink-700 border-pink-200'}`}>
  Virtual: {activeVirtualRupees > 0 ?'+' :''}₹{activeVirtualRupees.toFixed(0)}
  </span>
  )}
  <span className={`text-[11px] font-mono font-medium px-1.5 py-0.5 rounded border ${(strategyData.pnlPercent || 0) >= 0 ?'bg-emerald-50 text-emerald-700 border-emerald-200' :'bg-red-50 text-red-700 border-red-200'}`}>
  Total PnL: {(Number(strategyData.pnlPercent) || 0) > 0 ?'+' :''}{(Number(strategyData.pnlPercent) || 0).toFixed(2)}% | {totalRupees > 0 ?'+' :''}₹{totalRupees.toFixed(0)}
  </span>
  </>
  );
  })()}
  <span className="text-[10px] font-mono font-bold text-black bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded">
  Trade Value: ₹{(Number(strategyData.totalOriginalValue) || 0).toFixed(0)}
  </span>
 {strategyData.config?.overall_sl_enabled && (
 <span className="text-[10px] font-mono font-medium text-red-500 bg-red-50 border border-red-100 px-1.5 py-0.5 rounded">
 SL: -₹{(() => {
 const total = Number(strategyData.totalOriginalValue) || 0;
 const multiplier = strategyData.config?.quantity_multiplier || 1;
 const val = (strategyData.config.overall_sl_value || 0) * multiplier;
 const amt = (strategyData.config.overall_sl_type ==='PERCENTAGE'
 ? total * ((strategyData.config.overall_sl_value || 0) / 100)
 : val);
 return amt.toFixed(2);
 })()}
 </span>
 )}
 {strategyData.config?.overall_target_enabled && (
 <span className="text-[10px] font-mono font-medium text-emerald-600 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">
 Tgt: +₹{(() => {
 const total = Number(strategyData.totalOriginalValue) || 0;
 const multiplier = strategyData.config?.quantity_multiplier || 1;
 const val = (strategyData.config.overall_target_value || 0) * multiplier;
 const amt = (strategyData.config.overall_target_type ==='PERCENTAGE'
 ? total * ((strategyData.config.overall_target_value || 0) / 100)
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
 setViewStrategyName(strategyData.name || strategyData.config?.name ||'Strategy');
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
 {strategyData?.status ==="IN_POSITION" && (
 <Button
 size="sm"
 variant="outline"
 className="h-8 px-3 gap-1 rounded-md text-[11px] font-medium border-orange-200 bg-orange-50/50 hover:bg-orange-100 text-orange-600"
 onClick={() => handleSquareOff(id)}
 >
 Square Off
 </Button>
 )}
 {!isTerminal && (strategyData?.status === "IN_POSITION" || strategyData?.status === "WAITING") && (
  <Button
  size="sm"
  variant="outline"
  className={`h-8 px-3 gap-1 rounded-md text-[11px] font-medium border ${
  strategyData.is_virtual
  ? 'border-amber-200 bg-amber-50/50 hover:bg-amber-100 text-amber-700'
  : 'border-purple-200 bg-purple-50/50 hover:bg-purple-100 text-purple-700'
  }`}
  onClick={() => handleSwitchVirtual(id, !strategyData.is_virtual)}
  title={strategyData.is_virtual ? "Switch back from Virtual mode" : "Switch to Virtual background monitoring"}
  >
  <ShieldCheck className="h-3.5 w-3.5" />
  {strategyData.is_virtual ? (strategyData.config?.is_paper_trading ? "Switch to Paper" : "Switch to Live") : "Switch to Virtual"}
  </Button>
  )}
 {strategyData?.status ==="PAUSED" && (
 <Button
 size="sm"
 variant="outline"
 className="h-8 px-3 gap-1.5 rounded-md text-[11px] font-medium border-emerald-200 bg-emerald-50/50 hover:bg-emerald-100 text-emerald-600"
 onClick={() => handleResume(id)}
 >
 <RefreshCw className="h-3.5 w-3.5" /> Resume
 </Button>
 )}
 {!isTerminal && (
 <Button
 size="sm"
 variant="outline"
 className="h-8 px-3 gap-1 rounded-md text-[11px] font-medium border-red-200 bg-red-50/50 hover:bg-red-100 text-red-600"
 onClick={() => handleStop(id)}
 >
 <StopCircle className="h-3.5 w-3.5" /> Terminate
 </Button>
 )}
 {isTerminal && (
 <Button
 size="sm"
 variant="outline"
 className="h-8 px-3 gap-1 rounded-md text-[11px] font-medium border-slate-300 bg-slate-100 hover:bg-slate-200 text-slate-700"
 onClick={() => handleMoveToHistory(id)}
 >
 <Archive className="h-3.5 w-3.5" /> Move to History
 </Button>
 )}
 </div>
 </div>

 {collapsedSections[id] === true && (strategyData?.status ==="IN_POSITION" || strategyData?.status ==="PAUSED" || isTerminal) ? (
 <div className="space-y-2 pt-2 border-t border-border mt-1">
 {/* Strategy Legs */}

 {/* Running Legs */}
 {strategyData.legs?.filter(l => !l.exited || ["WAITING_FOR_RECOST","WAITING_FOR_MNTM","WAITING_FOR_RE_ASAP","WAITING_FOR_LAZY","WAITING_FOR_RESL_MNTM","WAITING_FOR_RE_HIGH","WAITING_FOR_RE_LOW","WAITING_FOR_SIMPLE_MNTM","WAITING_FOR_FILL","WAITING_FOR_INTERNAL_FALLBACK"].includes(l.state)).length > 0 && (
 <div className="space-y-2">
 <div
 className="flex items-center justify-between cursor-pointer group"
 onClick={() => setCollapsedSections(prev => ({ ...prev, [`${id}-running`]: prev[`${id}-running`] === true ? false : true }))}
 >
 <span className="text-[10px] font-medium uppercase text-muted-foreground group-hover:text-foreground transition-colors">{strategyData.is_virtual ? "Virtual Monitoring Legs" : "Running Legs"}</span>
 <Button variant="ghost" size="sm" className="h-4 w-4 p-0 shrink-0 text-muted-foreground group-hover:text-foreground">
 {collapsedSections[`${id}-running`] === true ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
 </Button>
 </div>
 {collapsedSections[`${id}-running`] === true && (
 <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
 {strategyData.legs.map((l, idx) => (!l.exited || ["WAITING_FOR_RECOST","WAITING_FOR_MNTM","WAITING_FOR_RE_ASAP","WAITING_FOR_LAZY","WAITING_FOR_RESL_MNTM","WAITING_FOR_RE_HIGH","WAITING_FOR_RE_LOW","WAITING_FOR_SIMPLE_MNTM","WAITING_FOR_FILL","WAITING_FOR_INTERNAL_FALLBACK"].includes(l.state)) && (
 <div key={idx} className="flex flex-col md:flex-row items-start md:items-center justify-between p-2.5 bg-white border border-border rounded-xl gap-3">
 <div className="flex flex-col">
 <div className="flex items-center gap-1 flex-wrap">
 <span className="text-[12px] font-medium">{l.instrument?.symbol ||"---"} ({l.leg?.side})</span>
 <span className="text-[11px] font-medium text-slate-600">
 {l.leg?.lots * (strategyData.config?.quantity_multiplier || 1)} {(l.leg?.lots * (strategyData.config?.quantity_multiplier || 1)) > 1 ?'Lots' :'Lot'}
 </span>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-primary font-medium text-[10px] font-mono">{l.entryTime ||"---"}</span>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-[10px] font-mono text-muted-foreground">Entry: {(l.entryPrice || 0).toFixed(2)}</span>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-[10px] font-mono animate-pulse text-blue-600 font-medium">LTP: {(l.currentLtp || 0).toFixed(2)}</span>
 {l.leg?.tsl_on_close_low && l.leg?.side === 'SELL' && l.candleLow != null && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-pink-600 font-bold text-[10px] font-mono">C.Low: {l.candleLow.toFixed(2)}</span>
 </>
 )}
 {l.leg?.tsl_on_close_high && l.leg?.side === 'BUY' && l.candleHigh != null && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-emerald-600 font-bold text-[10px] font-mono">C.High: {l.candleHigh.toFixed(2)}</span>
 </>
 )}
 {l.initialSlTriggerPrice != null && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-slate-500 font-medium text-[10px] font-mono">Init SL: {Number(l.initialSlTriggerPrice).toFixed(1)}</span>
 </>
 )}
 {l.slTriggerPrice != null && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className={`text-[10px] font-mono font-black ${Number(l.slTriggerPrice) !== Number(l.initialSlTriggerPrice) ?'text-indigo-600 animate-pulse' :'text-slate-800'}`}>
 Now SL: {Number(l.slTriggerPrice).toFixed(1)}
 </span>
 </>
 )}
 {/* Removed peakPrice display as per user request */}
 {l.rtp != null && !["WAITING_FOR_RE_HIGH","WAITING_FOR_RE_LOW"].includes(l.state) && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-orange-500 font-medium text-[10px] font-mono">RTP: {l.rtp.toFixed(2)}</span>
 </>
 )}
 {l.state ==="ACTIVE" && l.max_peak_price != null && l.max_peak_price > 0 && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-indigo-600 font-bold text-[10px] font-mono uppercase">Trig Peak: {l.max_peak_price.toFixed(2)}</span>
 </>
 )}
 {l.state ==="ACTIVE" && l.max_low_price != null && l.max_low_price > 0 && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-pink-600 font-bold text-[10px] font-mono uppercase">Trig Low: {l.max_low_price.toFixed(2)}</span>
 </>
 )}
 {l.mtp != null && !["WAITING_FOR_RE_HIGH","WAITING_FOR_RE_LOW"].includes(l.state) && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-purple-500 font-medium text-[10px] font-mono">MTP: {l.mtp.toFixed(2)}</span>
 </>
 )}
 {l.mntmTargetPrice != null && ["WAITING_FOR_SIMPLE_MNTM", "WAITING_FOR_FILL", "WAITING_FOR_INTERNAL_FALLBACK"].includes(l.state) && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-blue-500 font-medium animate-pulse text-[10px] font-mono">Wait Target: ₹{l.mntmTargetPrice.toFixed(2)}</span>
 </>
 )}
 {l.state ==="WAITING_FOR_RECOST" && (
 <span className="px-2 py-0.5 ml-2 bg-yellow-100 text-yellow-700 font-medium rounded text-[10px] font-mono">Waiting Re-Entry (Price)</span>
 )}
 {l.state ==="WAITING_FOR_RE_ASAP" && (
 <span className="px-2 py-0.5 ml-2 bg-blue-100 text-blue-700 font-medium rounded text-[10px] font-mono">Waiting Re-Entry (ASAP)</span>
 )}
 {l.state ==="WAITING_FOR_RESL_MNTM" && (
 <span className="px-2 py-0.5 ml-2 bg-purple-100 text-purple-700 font-medium rounded text-[10px] font-mono whitespace-nowrap">Waiting Re-Entry (SL Price Basis)</span>
 )}
 {l.state ==="WAITING_FOR_RE_HIGH" && (
 <>
 <span className="px-2 py-0.5 ml-2 bg-emerald-100 text-emerald-700 font-medium rounded text-[10px] font-mono whitespace-nowrap uppercase">Waiting (Peak Basis)</span>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-indigo-600 font-bold text-[10px] font-mono ml-1 uppercase">Peak: ₹{(l.max_peak_price || 0).toFixed(2)}</span>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-orange-600 font-bold text-[10px] font-mono ml-1 uppercase">RTP: ₹{(l.re_high_trigger_price || 0).toFixed(2)}</span>
 {l.mtp && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-blue-600 font-bold text-[10px] font-mono ml-1 uppercase">MTP: ₹{(l.mtp || 0).toFixed(2)}</span>
 </>
 )}
 </>
 )}
 {l.state ==="WAITING_FOR_RE_LOW" && (
 <>
 <span className="px-2 py-0.5 ml-2 bg-pink-100 text-pink-700 font-medium rounded text-[10px] font-mono whitespace-nowrap uppercase">Waiting (Low Basis)</span>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-indigo-600 font-bold text-[10px] font-mono ml-1 uppercase">Low: ₹{(l.max_low_price || 0).toFixed(2)}</span>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-orange-600 font-bold text-[10px] font-mono ml-1 uppercase">RTP: ₹{(l.re_low_trigger_price || 0).toFixed(2)}</span>
 {l.mtp && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono ml-1">|</span>
 <span className="text-blue-600 font-bold text-[10px] font-mono ml-1 uppercase">MTP: ₹{(l.mtp || 0).toFixed(2)}</span>
 </>
 )}
 </>
 )}
 {l.state ==="WAITING_FOR_FILL" && (
 <span className="px-2 py-0.5 ml-2 bg-amber-100 text-amber-700 font-medium rounded text-[10px] font-mono uppercase">Waiting For Fill</span>
 )}
 {l.state ==="WAITING_FOR_INTERNAL_FALLBACK" && (
 <span className="px-2 py-0.5 ml-2 bg-orange-100 text-orange-700 font-medium rounded text-[10px] font-mono uppercase">Internal Monitoring</span>
 )}
 {l.state ==="WAITING_FOR_LAZY" && (
 <span className="px-2 py-0.5 ml-2 bg-purple-100 text-purple-700 font-medium rounded text-[10px] font-mono">Initializing Lazy Leg</span>
 )}
 </div>
 </div>
 <div className="flex items-center gap-4">
 <div className="flex items-center gap-3">
 <span className={`text-[12px] font-mono font-medium ${(Number(l.currentActivePnlPercent) || 0) >= 0 ?'text-emerald-600' :'text-red-600'}`}>
 {(Number(l.currentActivePnlPercent) || 0) > 0 ?'+' :''}{(Number(l.currentActivePnlPercent) || 0).toFixed(2)}%
 </span>
 <span className={`text-[12px] font-mono font-medium ${(Number(l.currentActivePnlRupees) || 0) >= 0 ?'text-emerald-600' :'text-red-600'}`}>
 {(Number(l.currentActivePnlRupees) || 0) > 0 ?'+' :''}₹{(Number(l.currentActivePnlRupees) || 0).toFixed(2)}
 </span>
 </div>
 <Button
 size="sm"
 variant="outline"
 className="rounded-lg border-orange-500 hover:bg-orange-50 text-orange-600 text-[10px] font-medium px-3 h-8"
 onClick={() => handleSquareOffLeg(id, idx)}
 disabled={l.isExiting}
 >
 {l.isExiting ?"Exiting..." :
 (l.state ==="WAITING_FOR_RECOST" || l.state ==="WAITING_FOR_MNTM") ?"Cancel Re-Cost" :
 (l.state ==="WAITING_FOR_RE_ASAP" || l.state ==="WAITING_FOR_RESL_MNTM" || l.state ==="WAITING_FOR_RE_HIGH" || l.state ==="WAITING_FOR_RE_LOW") ?"Cancel Re-Entry" :
 (l.state ==="WAITING_FOR_LAZY") ?"Cancel Lazy Leg" :
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
 {collapsedSections[`${id}-closed`] === false ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
 </Button>
 </div>
 {collapsedSections[`${id}-closed`] !== false && (
 <div className="space-y-2 animate-in slide-in-from-top-2 duration-200">
 {strategyData.legs.map((l, idx) => l.exited && (
 <div key={idx} className="flex flex-col md:flex-row items-start md:items-center justify-between p-2.5 bg-muted/50 border border-border/50 rounded-xl opacity-90 gap-3">
 <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between w-full gap-y-2 gap-x-4">
 <div className="flex flex-1 items-center gap-1 flex-wrap">
 <span className="text-[12px] font-bold text-black">{l.instrument?.symbol ||"---"} ({l.leg?.side})</span>
 <span className="text-[11px] font-bold text-black/40">
 {l.leg?.lots * (strategyData.config?.quantity_multiplier || 1)} {(l.leg?.lots * (strategyData.config?.quantity_multiplier || 1)) > 1 ?'Lots' :'Lot'}
 </span>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-black font-bold text-[10px] font-mono">{l.entryTime ||"---"}</span>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-[10px] font-mono text-black">Entry: {(l.entryPrice || 0).toFixed(2)}</span>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-black font-bold text-[10px] font-mono">Exit: {l.exitTime || l.exitSnapshot?.exitTime ||"---"}</span>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-black text-[10px] font-mono">Price: {(l.exitSnapshot?.exitLtp || l.currentLtp || 0).toFixed(2)}</span>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-black text-[10px] font-mono font-bold">Type: {l.exitType || (l.is_virtual_monitoring ? "VIRTUAL_MONITORING" : "CLOSED")}</span>
 {l.initialSlTriggerPrice != null && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-red-400 font-medium text-[10px] font-mono">Init SL: {Number(l.initialSlTriggerPrice).toFixed(1)}</span>
 </>
 )}
 {(l.exitSnapshot?.slTriggerPrice != null || l.slTriggerPrice != null) && (
 <>
 <span className="text-muted-foreground text-[10px] font-mono">|</span>
 <span className="text-red-600 font-bold text-[10px] font-mono">Exit SL: {Number(l.exitSnapshot?.slTriggerPrice ?? l.slTriggerPrice).toFixed(1)}</span>
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
 {(l.max_peak_price != null || l.peakPrice != null || l.exitSnapshot?.peakPrice != null) && (
 <>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-indigo-600 font-bold text-[10px] font-mono uppercase">Trig Peak: {(l.max_peak_price || l.peakPrice || l.exitSnapshot?.peakPrice).toFixed(2)}</span>
 </>
 )}
 {(l.max_low_price != null || l.exitSnapshot?.lowPrice != null) && (
 <>
 <span className="text-black/30 text-[10px] font-mono">|</span>
 <span className="text-pink-600 font-bold text-[10px] font-mono uppercase">Trig Low: {(l.max_low_price || l.exitSnapshot?.lowPrice).toFixed(2)}</span>
 </>
 )}
 </div>
 <div className="flex items-center gap-3 shrink-0">
 <span className={`text-[12px] font-mono font-medium ${(Number(l.pnlPercent) || 0) >= 0 ?'text-emerald-600' :'text-red-600'}`}>
 {(Number(l.pnlPercent) || 0) > 0 ?'+' :''}{(Number(l.pnlPercent) || 0).toFixed(2)}%
 </span>
 <span className={`text-[12px] font-mono font-medium ${(Number(l.pnlRupees) || 0) >= 0 ?'text-emerald-600' :'text-red-600'}`}>
 {(Number(l.pnlRupees) || 0) > 0 ?'+' :''}₹{(Number(l.pnlRupees) || 0).toFixed(2)}
 </span>
 <span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase ${(l.is_virtual_leg || l.is_virtual_monitoring) ? "bg-purple-100 text-purple-800 border border-purple-200" : "bg-slate-200 text-black"}`}>
 {(l.is_virtual_leg || l.is_virtual_monitoring) ? "Virtual Closed" : "Closed"}
 </span>
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
 );
 })}
 {Object.entries(runningStrategies).filter(([_, strategyData]) => {
 const isPaper = !!strategyData.config?.is_paper_trading;
 return activeTab ==='paper' ? isPaper : !isPaper;
 }).length === 0 && (
 <div className="flex flex-col items-center justify-center p-12 bg-white border-2 border-dashed border-slate-200 rounded-[2rem] text-center">
 <div className="h-16 w-16 bg-slate-50 text-slate-300 rounded-2xl flex items-center justify-center mb-4">
 <Play className="h-8 w-8" />
 </div>
 <h3 className="text-sm font-medium text-slate-900">No {activeTab ==='paper' ?'Paper' :'Live'} Strategies Active</h3>
 <p className="text-xs text-slate-500 mt-1">Deploy a strategy from your templates to see it here.</p>
 </div>
 )}
 </div>
 )}
 </div>
 )
 }

 <TabsList className="grid w-full grid-cols-2 mb-4 mt-8 h-10 bg-muted/50 p-1 rounded-lg">
 <TabsTrigger value="live" className="rounded-md font-medium text-[11px] data-[state=active]:bg-orange-600 data-[state=active]:text-white flex items-center gap-2 transition-all">
 <Zap className="h-4 w-4" /> Live Market
 </TabsTrigger>
 <TabsTrigger value="paper" className="rounded-md font-medium text-[11px] data-[state=active]:bg-blue-600 data-[state=active]:text-white flex items-center gap-2 transition-all">
 <ShieldCheck className="h-4 w-4" /> Paper Trading
 </TabsTrigger>
 </TabsList>

 <Card className="w-full border-border bg-card mt-2">
 <div
 className="border-b bg-muted/60 py-3 px-4 flex flex-col md:flex-row items-center justify-between gap-2 cursor-pointer hover:bg-muted/80 transition-colors"
 onClick={(e) => {
 if (e.target.closest('input')) return;
 setCollapsedSections(prev => ({ ...prev,'saved-strategies': !prev['saved-strategies'] }));
 }}
 >
 <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
 <Save className="h-4 w-4 text-primary" /> Saved Strategies
 </CardTitle>
 <div className="flex items-center gap-3 w-full md:w-auto">
 {selectedForCombined.length > 1 && (
 <Button
 size="sm"
 className="h-8 text-[10px] uppercase font-black bg-indigo-600 hover:bg-indigo-700 text-white transition-all animate-in zoom-in-95"
 onClick={(e) => {
 e.stopPropagation();
 const selectedStrats = savedStrategies.filter(s => selectedForCombined.includes(s.id));
 setSelectedStrategyForBacktest(selectedStrats);
 setBacktestModalOpen(true);
 fetchDates(selectedStrats[0]?.config?.index ||'NIFTY');
 }}
 >
 <Play className="h-3 w-3 mr-1 fill-current" />
 Simulate Portfolio ({selectedForCombined.length})
 </Button>
 )}
 {selectedForCombined.length > 0 && (
 <Button
 size="sm"
 variant="outline"
 className="h-8 gap-1 rounded-md text-[10px] font-medium border-indigo-200 hover:bg-indigo-50 text-indigo-700 animate-in zoom-in-95"
 onClick={(e) => {
 e.stopPropagation();
 setMoveStrategiesModalOpen(true);
 }}
 >
 <FolderPlus className="h-3 w-3" /> Move ({selectedForCombined.length})
 </Button>
 )}
 <Button
 variant="outline"
 size="sm"
 className="h-8 gap-1 rounded-md text-[10px] font-medium border-slate-200 hover:bg-slate-50 text-slate-600"
 onClick={(e) => { e.stopPropagation(); handleUploadClick(); }}
 title="Upload Strategy"
 >
 <Upload className="h-3 w-3" /> Upload
 </Button>
 <Button
 variant="outline"
 size="sm"
 className="h-8 gap-1 rounded-md text-[10px] font-medium border-slate-200 hover:bg-slate-50 text-slate-600"
 onClick={(e) => { e.stopPropagation(); handleCreateFolder(); }}
 title="New Folder"
 >
 <FolderPlus className="h-3 w-3" /> New Folder
 </Button>
 <div className="relative w-full md:w-64" onClick={e => e.stopPropagation()}>
 <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
 <Input
 type="text"
 placeholder="Search by strategy name or ID..."
 className="h-8 pl-8 pr-3 rounded-lg text-[10px] bg-white/50 border-none focus-visible:ring-1 focus-visible:ring-primary/20"
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
 <div className="divide-y border-t flex flex-col">
 <FolderTree
 folders={folders}
 strategies={savedStrategies}
 onDropStrategy={handleMoveStrategy}
 onDeleteFolder={handleDeleteFolder}
 onRenameFolder={handleRenameFolder}
 onCreateFolder={handleCreateFolder}
 onToggleCombine={setSelectedForCombined}
 selectedForCombined={selectedForCombined}
 renderStrategyRow={renderStrategyRow}
 searchTerm={searchTerm}
 />
 </div>
 </div>
 </CardContent>
 )}
 </Card>
 <StrategyLogs
 isOpen={logWindowOpen}
 onClose={() => setLogWindowOpen(false)}
 logs={logStrategyId ? runningStrategies[logStrategyId]?.logs : []}
 strategyName={logStrategyId ? (runningStrategies[logStrategyId]?.name || runningStrategies[logStrategyId]?.config?.name ||'Strategy') :''}
 />
 <StrategyConfigModal
 isOpen={configWindowOpen}
 onClose={() => setConfigWindowOpen(false)}
 strategy={{ config: viewConfig, name: viewStrategyName }}
 />
 <ExecutionSettingsModal
 isOpen={executionModalOpen}
 onClose={() => setExecutionModalOpen(false)}
 strategy={selectedStrategyForExecution}
 onSave={handleExecutionSettingsSave}
 />

 {backtestModalOpen && selectedStrategyForBacktest && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) setBacktestModalOpen(false); }}>
 <Card className="w-full max-w-sm border-none bg-white overflow-hidden transform transition-all animate-in zoom-in-95 duration-200">
 <CardHeader className="bg-slate-50/80 border-b border-slate-100 py-3 px-4">
 <div className="flex items-center justify-between">
 <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700">
 <Database className="h-3.5 w-3.5 text-indigo-500" />
 Run Backtest
 </CardTitle>
 <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-slate-200/50" onClick={() => setBacktestModalOpen(false)}>
 <X className="h-3.5 w-3.5 text-slate-500" />
 </Button>
 </div>
 </CardHeader>
 <CardContent className="p-4 space-y-4">
 <div className="space-y-1.5">
 <Label className="text-[10px] font-bold uppercase tracking-tight text-slate-500">Strategy</Label>
 <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">
 <div className="h-1.5 w-1.5 rounded-full bg-indigo-500"></div>
 {Array.isArray(selectedStrategyForBacktest)
 ?`Portfolio (${selectedStrategyForBacktest.length} strategies)`
 : (selectedStrategyForBacktest.name || selectedStrategyForBacktest.config?.name ||'Unnamed Strategy')}
 </div>
 </div>

 <div className="space-y-1.5">
 <div className="grid grid-cols-2 gap-3 mb-2">
 <div className="space-y-1">
 <Label className="text-[10px] font-bold uppercase tracking-tight text-slate-500">From Date</Label>
 <Input
 value={dateRange.from ||''}
 onChange={(e) => {
 let val = e.target.value.replace(/\D/g,'');
 if (val.length > 8) val = val.slice(0, 8);
 let formatted = val;
 if (val.length > 4) formatted = val.slice(0, 4) +'-' + val.slice(4);
 if (val.length > 6) formatted = formatted.slice(0, 7) +'-' + formatted.slice(7);
 setDateRange(prev => ({ ...prev, from: formatted }));
 }}
 onFocus={() => setActiveDateInput('from')}
 placeholder="YYYY-MM-DD"
 maxLength={10}
 className={`h-9 rounded-lg text-xs font-mono font-medium transition-all ${activeDateInput ==='from' ?'border-indigo-500 ring-2 ring-indigo-500/20' :'border-slate-200'}`}
 />
 </div>
 <div className="space-y-1">
 <Label className="text-[10px] font-bold uppercase tracking-tight text-slate-500">To Date</Label>
 <Input
 value={dateRange.to ||''}
 onChange={(e) => {
 let val = e.target.value.replace(/\D/g,'');
 if (val.length > 8) val = val.slice(0, 8);
 let formatted = val;
 if (val.length > 4) formatted = val.slice(0, 4) +'-' + val.slice(4);
 if (val.length > 6) formatted = formatted.slice(0, 7) +'-' + formatted.slice(7);
 setDateRange(prev => ({ ...prev, to: formatted }));
 }}
 onFocus={() => setActiveDateInput('to')}
 placeholder="YYYY-MM-DD"
 maxLength={10}
 className={`h-9 rounded-lg text-xs font-mono font-medium transition-all ${activeDateInput ==='to' ?'border-indigo-500 ring-2 ring-indigo-500/20' :'border-slate-200'}`}
 />
 </div>
 </div>
 <div className="border border-slate-200 rounded-lg p-3 bg-white">
 {loadingDates ? (
 <div className="flex items-center justify-center gap-2 text-xs font-medium text-slate-500 py-6">
 <Loader2 className="h-4 w-4 animate-spin text-indigo-500" /> Scanning market data...
 </div>
 ) : availableDates.length === 0 ? (
 <div className="text-xs font-medium text-red-500 text-center py-6">
 No market data found for {Array.isArray(selectedStrategyForBacktest) ? selectedStrategyForBacktest[0].config?.index : selectedStrategyForBacktest.config?.index}.
 </div>
 ) : (
 <CalendarPicker
 availableDates={availableDates}
 dateRange={dateRange}
 onSelect={handleDateSelect}
 />
 )}
 </div>
 </div>

 <Button
 className="w-full h-9 rounded-lg text-xs font-bold gap-2 bg-slate-900 hover:bg-slate-800 text-white transition-all active:scale-[0.98]"
 disabled={!dateRange.from || !dateRange.to || loadingDates || isBacktesting}
 onClick={async () => {
 const stratIdKey = Array.isArray(selectedStrategyForBacktest)
 ? selectedStrategyForBacktest.map(s => s.id).sort().join('_')
 : selectedStrategyForBacktest.id;
 localStorage.setItem(`backtest_dates_${stratIdKey}`, JSON.stringify(dateRange));

 setIsBacktesting(true);
 try {
 let response;
 if (Array.isArray(selectedStrategyForBacktest)) {
 const ids = selectedStrategyForBacktest.map(s => s.id);
 response = await runCombinedBacktest(ids, dateRange.from, dateRange.to);
 } else {
 response = await runBacktest(selectedStrategyForBacktest.id, dateRange.from, dateRange.to);
 }

 if (response.success && response.jobId) {
 const pollInterval = setInterval(async () => {
 try {
 const statusRes = await getBacktestStatus(response.jobId);
 if (statusRes.success) {
 if (statusRes.status ==='completed') {
 clearInterval(pollInterval);
 if (onBacktestComplete) {
 const strategyArg = Array.isArray(selectedStrategyForBacktest)
 ? { name:"Portfolio Simulation", id:"portfolio", isCombined: true, strategies: selectedStrategyForBacktest }
 : selectedStrategyForBacktest;
 onBacktestComplete(statusRes.data, strategyArg);
 }
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 } else if (statusRes.status ==='failed') {
 clearInterval(pollInterval);
 alert("Backtest failed:" + statusRes.message);
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 }
 } else {
 clearInterval(pollInterval);
 alert("Failed to get status:" + statusRes.message);
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 }
 } catch (e) {
 clearInterval(pollInterval);
 alert("Error checking status:" + e.message);
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 }
 }, 2000);
 } else {
 alert("Backtest failed:" + response.message);
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 }
 } catch (e) {
 alert("Error during backtest:" + e.message);
 setIsBacktesting(false);
 setBacktestModalOpen(false);
 }
 }}
 >
 {isBacktesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
 {isBacktesting ?'Running Simulation...' :'Start Backtest'}
 </Button>
 </CardContent>
 </Card>
 </div>
 )}

 {deployModalOpen && selectedStrategyForDeploy && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) setDeployModalOpen(false); }}>
 <Card className="w-full max-w-sm border-none bg-white overflow-hidden transform transition-all animate-in zoom-in-95 duration-200">
 <CardHeader className="bg-slate-50/80 border-b border-slate-100 py-3 px-4">
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-2">
 <div className="h-6 w-6 rounded bg-indigo-100 flex items-center justify-center text-indigo-600">
 <Play className="h-3 w-3" />
 </div>
 <CardTitle className="text-sm font-bold text-slate-800">Deploy Strategy</CardTitle>
 </div>
 <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-slate-200" onClick={() => setDeployModalOpen(false)}>
 <X className="h-3 w-3" />
 </Button>
 </div>
 </CardHeader>
 <CardContent className="p-4 bg-white flex flex-col gap-3">
 <p className="text-xs text-slate-600 text-center mb-1">
 How would you like to deploy <strong>{selectedStrategyForDeploy.name || selectedStrategyForDeploy.config?.name ||'Strategy'}</strong>?
 </p>
 <div className="flex gap-3">
 <Button
 className="flex-1 h-10 rounded-lg text-xs font-bold gap-2 bg-blue-600 hover:bg-blue-700 text-white transition-all active:scale-[0.98]"
 onClick={() => {
 handleExecute(selectedStrategyForDeploy.id, 'paper');
 setDeployModalOpen(false);
 }}
 >
 <ShieldCheck className="h-4 w-4 shrink-0" /> Paper
 </Button>
 <Button
 className="flex-1 h-10 rounded-lg text-xs font-bold gap-2 bg-orange-600 hover:bg-orange-700 text-white transition-all active:scale-[0.98]"
 onClick={() => {
 handleExecute(selectedStrategyForDeploy.id, 'live');
 setDeployModalOpen(false);
 }}
 >
 <Zap className="h-4 w-4 shrink-0" /> Live
 </Button>
 </div>
 </CardContent>
 </Card>
 </div>
 )}
 {folderModalOpen && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) setFolderModalOpen(false); }}>
 <Card className="w-[320px] bg-slate-50 border-none shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
 <CardHeader className="p-3 border-b bg-white relative">
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-2">
 <FolderPlus className="h-4 w-4 text-primary" />
 <CardTitle className="text-xs font-black uppercase tracking-wider text-black m-0 p-0 leading-none">
 {folderModalData?.mode === 'create' ? 'Create Folder' : 'Rename Folder'}
 </CardTitle>
 </div>
 <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-slate-200" onClick={() => setFolderModalOpen(false)}>
 <X className="h-3 w-3" />
 </Button>
 </div>
 </CardHeader>
 <CardContent className="p-4 bg-white flex flex-col gap-4">
 <div className="space-y-2">
 <Label htmlFor="folderName" className="text-[10px] font-bold uppercase text-slate-500">Folder Name</Label>
 <Input
 id="folderName"
 type="text"
 placeholder="e.g. My Options Strategies"
 className="h-8 text-xs focus-visible:ring-1"
 value={folderNameInput}
 onChange={(e) => setFolderNameInput(e.target.value)}
 onKeyDown={(e) => {
 if (e.key === 'Enter') submitFolderModal();
 if (e.key === 'Escape') setFolderModalOpen(false);
 }}
 autoFocus
 />
 </div>
 <Button
 className="w-full h-8 rounded-md text-xs font-bold gap-2 bg-primary hover:bg-primary/90 text-primary-foreground transition-all active:scale-[0.98]"
 onClick={submitFolderModal}
 disabled={!folderNameInput.trim()}
 >
 <Save className="h-3 w-3 shrink-0" /> Save Folder
 </Button>
 </CardContent>
 </Card>
 </div>
 )}
 {moveStrategiesModalOpen && (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={(e) => { if (e.target === e.currentTarget) setMoveStrategiesModalOpen(false); }}>
 <Card className="w-[320px] bg-slate-50 border-none shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
 <CardHeader className="p-3 border-b bg-white relative">
 <div className="flex items-center justify-between">
 <div className="flex items-center gap-2">
 <FolderPlus className="h-4 w-4 text-primary" />
 <CardTitle className="text-xs font-black uppercase tracking-wider text-black m-0 p-0 leading-none">
 Move Strategies
 </CardTitle>
 </div>
 <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-slate-200" onClick={() => setMoveStrategiesModalOpen(false)}>
 <X className="h-3 w-3" />
 </Button>
 </div>
 </CardHeader>
 <CardContent className="p-4 bg-white flex flex-col gap-4">
 <div className="space-y-2">
 <Label className="text-[10px] font-bold uppercase text-slate-500">Select Destination Folder</Label>
 <div className="flex flex-col gap-1 max-h-[200px] overflow-y-auto pr-1">
 <div
 className={`p-2 text-xs rounded border cursor-pointer flex items-center justify-between transition-colors ${moveTargetFolderId === null ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
 onClick={() => setMoveTargetFolderId(null)}
 >
 <div className="flex items-center gap-2">
 <FolderPlus className={`h-4 w-4 ${moveTargetFolderId === null ? 'text-indigo-600' : 'text-slate-400'}`} />
 <span className={moveTargetFolderId === null ? 'font-bold text-indigo-700' : 'text-slate-600'}>Root (No Folder)</span>
 </div>
 {moveTargetFolderId === null && <Check className="h-4 w-4 text-indigo-600" />}
 </div>
 {folders.map(f => (
 <div
 key={f.id}
 className={`p-2 text-xs rounded border cursor-pointer flex items-center justify-between transition-colors ${moveTargetFolderId === f.id ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
 onClick={() => setMoveTargetFolderId(f.id)}
 >
 <div className="flex items-center gap-2">
 <FolderPlus className={`h-4 w-4 ${moveTargetFolderId === f.id ? 'text-indigo-600' : 'text-slate-400'}`} />
 <span className={moveTargetFolderId === f.id ? 'font-bold text-indigo-700' : 'text-slate-600'}>{f.name}</span>
 </div>
 {moveTargetFolderId === f.id && <Check className="h-4 w-4 text-indigo-600" />}
 </div>
 ))}
 </div>
 </div>
 <Button
 className="w-full h-8 rounded-md text-xs font-bold gap-2 bg-primary hover:bg-primary/90 text-primary-foreground transition-all active:scale-[0.98]"
 onClick={handleMoveMultipleStrategies}
 >
 <Save className="h-3 w-3 shrink-0" /> Move {selectedForCombined.length} Strategies
 </Button>
 </CardContent>
 </Card>
 </div>
 )}


 </Tabs>
 </div >
 );
};
