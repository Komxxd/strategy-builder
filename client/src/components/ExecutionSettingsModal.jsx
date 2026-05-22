import React, { useState, useEffect } from 'react';
import { X, Save, Sliders } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const ExecutionSettingsModal = ({ isOpen, onClose, strategy, onSave }) => {
    const [multiplier, setMultiplier] = useState(1);

    useEffect(() => {
        if (strategy && strategy.config) {
            setMultiplier(strategy.config.quantity_multiplier || 1);
        }
    }, [strategy, isOpen]);

    if (!isOpen || !strategy) return null;

    const handleSave = async () => {
        await onSave(strategy.id, {
            quantity_multiplier: parseFloat(multiplier) || 1
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <Card className="w-full max-w-sm border-none shadow-2xl bg-white overflow-hidden transform transition-all animate-in zoom-in-95 duration-200">
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

                    <Button
                        onClick={handleSave}
                        className="w-full h-9 rounded-lg text-xs font-bold gap-2 bg-slate-900 hover:bg-slate-800 text-white shadow-lg shadow-slate-900/10 transition-all active:scale-[0.98]"
                    >
                        <Save className="h-3.5 w-3.5" />
                        Save Settings
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
};
