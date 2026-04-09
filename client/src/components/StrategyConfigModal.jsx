import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X } from 'lucide-react';
import { StrategyFormContent } from './StrategyBuilder';

export function StrategyConfigModal({ isOpen, onClose, config, strategyName }) {
    // Prevent background scrolling when modal is open
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => { document.body.style.overflow = 'unset'; };
    }, [isOpen]);

    if (!isOpen || !config) return null;

    const modalContent = (
        <div
            className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[4px] transition-all duration-500 ease-in-out animate-in fade-in"
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className="bg-white w-[95%] max-w-5xl max-h-[90vh] flex flex-col rounded-xl shadow-[0_24px_48px_-12px_rgba(0,0,0,0.25)] border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-8 duration-500 fill-mode-forwards ease-out">
                {/* Compact Header */}
                <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-white shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="h-9 w-9 bg-slate-900 rounded-lg flex items-center justify-center shadow-md">
                            <Settings2 className="h-5 w-5 text-white" />
                        </div>
                        <div>
                            <h3 className="text-[11px] font-medium text-slate-900 tracking-tight leading-none">Strategy Configuration</h3>
                            <p className="text-[8px] font-medium text-slate-400 uppercase tracking-widest mt-1 opacity-70">
                                {strategyName || config.name || 'Unnamed'} (View Only)
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

                {/* Configuration Content - Rendered exactly as StrategyBuilder natively */}
                <div className="flex-1 overflow-y-auto w-full custom-scrollbar bg-slate-50/50">
                    <div className="p-3 w-full max-w-6xl mx-auto h-full"> 
                        <StrategyFormContent 
                            config={config} 
                            setConfig={() => {}} 
                            isReadOnly={true} 
                        />
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
