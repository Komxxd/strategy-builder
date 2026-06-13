import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X, Layers } from 'lucide-react';
import { StrategyFormContent } from './StrategyBuilder';

export function StrategyConfigModal({ isOpen, onClose, strategy }) {
    const [activeTabId, setActiveTabId] = useState(null);

    // Prevent background scrolling when modal is open
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
            if (strategy?.isCombined && strategy?.strategies?.length > 0) {
                setActiveTabId(strategy.strategies[0].id);
            } else {
                setActiveTabId(null);
            }
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => { document.body.style.overflow = 'unset'; };
    }, [isOpen, strategy]);

    if (!isOpen || !strategy) return null;

    let displayConfig = strategy?.config;
    let displayName = strategy?.name || 'Unnamed';

    if (strategy?.isCombined && strategy?.strategies) {
        const activeStrat = strategy.strategies.find(s => s.id === activeTabId) || strategy.strategies[0];
        if (activeStrat) {
            displayConfig = activeStrat.config;
            displayName = activeStrat.name;
        }
    }

    if (!displayConfig) return null;

    const modalContent = (
        <div
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[4px] transition-all duration-500 ease-in-out animate-in fade-in"
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="bg-white w-[95%] max-w-5xl max-h-[90vh] flex flex-col rounded-xl shadow-[0_24px_48px_-12px_rgba(0,0,0,0.25)] border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-8 duration-500 fill-mode-forwards ease-out">
                {/* Compact Header */}
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50 shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="h-9 w-9 bg-slate-900 rounded-lg flex items-center justify-center shadow-md">
                            {strategy?.isCombined ? <Layers className="h-5 w-5 text-white" /> : <Settings2 className="h-5 w-5 text-white" />}
                        </div>
                        <div>
                            <h3 className="text-[11px] font-bold text-slate-900 tracking-tight leading-none uppercase">
                                {strategy?.isCombined ? 'Portfolio Configuration' : 'Strategy Configuration'}
                            </h3>
                            <p className="text-[9px] font-bold text-slate-400 tracking-widest mt-1">
                                {strategy?.isCombined ? strategy?.name : displayName} (View Only)
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-slate-200 transition-all text-slate-500 hover:text-slate-900 bg-white border border-slate-200 shadow-sm"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Tabs for Combined Strategies */}
                {strategy?.isCombined && strategy?.strategies?.length > 1 && (
                    <div className="flex px-5 pt-3 bg-slate-50 border-b border-slate-200 overflow-x-auto no-scrollbar gap-2 shrink-0">
                        {strategy.strategies.map(s => (
                            <button
                                key={s.id}
                                onClick={() => setActiveTabId(s.id)}
                                className={`px-4 py-2 text-[11px] font-bold rounded-t-lg transition-all border ${activeTabId === s.id ? 'bg-white text-indigo-600 border-slate-200 border-b-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200 border-transparent hover:text-slate-800'}`}
                                style={{ marginBottom: activeTabId === s.id ? '-1px' : '0' }}
                            >
                                {s.name}
                            </button>
                        ))}
                    </div>
                )}

                {/* Configuration Content - Rendered exactly as StrategyBuilder natively */}
                <div className="flex-1 overflow-y-auto w-full custom-scrollbar bg-slate-50/50">
                    <div className="p-3 w-full max-w-6xl mx-auto h-full">
                        <StrategyFormContent
                            config={displayConfig}
                            setConfig={() => { }}
                            isReadOnly={true}
                        />
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
