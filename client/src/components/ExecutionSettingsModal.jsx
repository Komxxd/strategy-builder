import React, { useState, useEffect, useMemo } from'react';
import { X, Save, Sliders, AlertTriangle } from'lucide-react';
import { Button } from'@/components/ui/button';
import { Input } from'@/components/ui/input';
import { Label } from'@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from'@/components/ui/card';

// Exchange-mandated lot limits per index
const LOT_LIMITS = {
 NIFTY: 27,
 SENSEX: 50,
 BANKNIFTY: 30,
 FINNIFTY: 40,
};

export const ExecutionSettingsModal = ({ isOpen, onClose, strategy, onSave }) => {
 const [multiplier, setMultiplier] = useState(1);

 useEffect(() => {
 if (strategy && strategy.config) {
 setMultiplier(strategy.config.quantity_multiplier || 1);
 }
 }, [strategy, isOpen]);

 const index = strategy?.config?.index || 'NIFTY';
 const maxLots = LOT_LIMITS[index] || 27;
 const legs = strategy?.config?.legs || [];

 // Check if any leg would exceed the lot limit with the current multiplier
 const lotWarnings = useMemo(() => {
 const mult = parseFloat(multiplier) || 1;
 return legs
  .map((leg, i) => {
   const effectiveLots = (leg.lots || 1) * mult;
   if (effectiveLots > maxLots) {
    return { legIndex: i + 1, effectiveLots: Math.round(effectiveLots * 100) / 100, legLots: leg.lots };
   }
   return null;
  })
  .filter(Boolean);
 }, [legs, multiplier, maxLots]);

 if (!isOpen || !strategy) return null;

 const handleSave = async () => {
 if (lotWarnings.length > 0) return; // Block save if exceeding limit
 await onSave(strategy.id, {
  quantity_multiplier: parseFloat(multiplier) || 1
 });
 onClose();
 };

 return (
 <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
 <Card className="w-full max-w-sm border-none bg-white overflow-hidden transform transition-all animate-in zoom-in-95 duration-200">
 <CardHeader className="bg-slate-50/80 border-b border-slate-100 py-3 px-4">
  <div className="flex items-center justify-between">
  <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-700">
   <Sliders className="h-3.5 w-3.5 text-indigo-500" />
   Execution Settings
  </CardTitle>
  <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-slate-200/50" onClick={onClose}>
   <X className="h-3.5 w-3.5 text-slate-500" />
  </Button>
  </div>
 </CardHeader>
 <CardContent className="p-4 space-y-4">
  <div className="space-y-1.5">
  <div className="flex items-center justify-between">
   <Label className="text-[10px] font-bold uppercase tracking-tight text-slate-500">
   Quantity Multiplier
   </Label>
   <span className="text-[10px] font-mono font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
   {multiplier}x
   </span>
  </div>
  <Input
   type="number"
   step="0.1"
   min="0.1"
   value={multiplier}
   onChange={(e) => setMultiplier(e.target.value)}
   className="h-9 rounded-lg text-xs font-medium border-slate-200 focus:ring-indigo-500/20"
   placeholder="e.g. 1.0, 2.0"
  />
  </div>

  {/* Lot Limit Info */}
  <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
  <div className="flex items-center justify-between">
   <span className="text-[10px] font-bold uppercase tracking-tight text-slate-500">
   Max Lots Per Leg ({index})
   </span>
   <span className="text-[10px] font-mono font-bold text-slate-700 bg-white px-1.5 py-0.5 rounded border border-slate-200">
   {maxLots}L
   </span>
  </div>
  </div>

  {/* Lot Limit Warning */}
  {lotWarnings.length > 0 && (
  <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 space-y-1">
   <div className="flex items-center gap-1.5">
   <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
   <span className="text-[10px] font-bold uppercase tracking-tight text-red-600">
    Lot Limit Exceeded
   </span>
   </div>
   {lotWarnings.map((w) => (
   <p key={w.legIndex} className="text-[10px] text-red-600 pl-5">
    Leg {w.legIndex}: {w.legLots} lots × {multiplier}x = {w.effectiveLots}L (max {maxLots}L)
   </p>
   ))}
  </div>
  )}

  <Button
  onClick={handleSave}
  disabled={lotWarnings.length > 0}
  className="w-full h-9 rounded-lg text-xs font-bold gap-2 bg-slate-900 hover:bg-slate-800 text-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
  >
  <Save className="h-3.5 w-3.5" />
  Save Settings
  </Button>
 </CardContent>
 </Card>
 </div>
 );
};
