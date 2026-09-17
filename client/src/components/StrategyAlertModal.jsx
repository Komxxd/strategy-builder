import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export function StrategyAlertModal({ isOpen, onClose, alert, strategyName }) {
    if (!isOpen || !alert) return null;

    return (
        <div
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[4px] transition-all duration-500 ease-in-out animate-in fade-in"
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="bg-white w-full max-w-md flex flex-col rounded-xl border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-8 duration-500 fill-mode-forwards ease-out">
                {/* Compact Header */}
                <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
                    <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 bg-red-100 rounded-lg flex items-center justify-center">
                            <AlertTriangle className="h-4 w-4 text-red-600" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-900 tracking-tight leading-none">System Warning</h3>
                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1 opacity-70">
                                {strategyName}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-slate-100 transition-all text-slate-400 hover:text-slate-900"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 p-5 bg-slate-50/30 flex flex-col items-center justify-center text-center">
                    <AlertTriangle className="h-10 w-10 text-red-500 mb-3" />
                    <h4 className="text-sm font-bold text-slate-800 mb-1">Attention Required</h4>
                    <p className="text-sm text-slate-600">
                        {alert.message}
                    </p>
                    
                    <button 
                        onClick={onClose}
                        className="mt-5 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
