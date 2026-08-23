import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, X, Layers, FileText, Loader2 } from 'lucide-react';
import { StrategyFormContent } from './StrategyBuilder';

export function StrategyConfigModal({ isOpen, onClose, strategy, autoDownloadPdf, onAutoDownloadComplete }) {
  const [activeTabId, setActiveTabId] = useState(null);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const contentRef = useRef(null);
  const autoDownloadTriggered = useRef(false);


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

  // Auto-trigger PDF download when opened with autoDownloadPdf prop
  useEffect(() => {
    if (isOpen && autoDownloadPdf && contentRef.current && !autoDownloadTriggered.current) {
      autoDownloadTriggered.current = true;
      // Wait for the content to fully render
      const timer = setTimeout(() => {
        handleDownloadPdf().then(() => {
          if (onAutoDownloadComplete) onAutoDownloadComplete();
        });
      }, 500);
      return () => clearTimeout(timer);
    }
    if (!isOpen || !autoDownloadPdf) {
      autoDownloadTriggered.current = false;
    }
  }, [isOpen, autoDownloadPdf]);

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

  const handleDownloadPdf = async () => {
    try {
      setIsDownloadingPdf(true);
      const captureTarget = contentRef.current;
      if (!captureTarget) return;

      // Clone the content HTML
      const contentHtml = captureTarget.innerHTML;

      // Collect all stylesheets from the current page
      const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
        .map(el => el.outerHTML)
        .join('\n');

      // Get computed CSS variables from :root
      const rootStyles = document.documentElement.getAttribute('style') || '';
      const computedRootVars = getComputedStyle(document.documentElement);
      const cssVarNames = Array.from(document.styleSheets)
        .flatMap(sheet => {
          try { return Array.from(sheet.cssRules); } catch { return []; }
        })
        .filter(rule => rule.selectorText === ':root')
        .flatMap(rule => Array.from(rule.style))
        .filter(prop => prop.startsWith('--'));
      
      const cssVarsStr = cssVarNames.map(name => `${name}: ${computedRootVars.getPropertyValue(name)};`).join('\n');

      const pdfName = (strategy?.isCombined ? strategy?.name : displayName) || 'Strategy Configuration';

      const printHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>${pdfName}</title>
          ${stylesheets}
          <style>
            :root { ${cssVarsStr} }
            html, body {
              margin: 0;
              padding: 0;
              background: white !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color-adjust: exact !important;
            }
            body {
              padding: 16px;
            }
            /* Hide scrollbars and ensure full content is visible */
            * {
              overflow: visible !important;
              max-height: none !important;
            }
            /* Print-specific tweaks */
            @media print {
              body { padding: 8px; }
              * {
                overflow: visible !important;
                max-height: none !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
              }
            }
            /* Hide any elements with hide-on-readonly class */
            .hide-on-readonly { display: none !important; }
          </style>
        </head>
        <body>
          <div style="max-width: 1100px; margin: 0 auto; background: white;">
            <div style="padding: 12px 0 16px 0; border-bottom: 2px solid #6366f1; margin-bottom: 16px;">
              <h1 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0 0 4px 0; font-family: system-ui, sans-serif;">
                ${strategy?.isCombined ? 'Portfolio' : 'Strategy'} Configuration
              </h1>
              <p style="font-size: 12px; color: #94a3b8; margin: 0; font-family: system-ui, sans-serif;">
                ${pdfName}
              </p>
            </div>
            <div class="p-3 w-full bg-white rounded-lg">
              ${contentHtml}
            </div>
          </div>
        </body>
        </html>
      `;

      // Open print window
      const printWindow = window.open('', '_blank', 'width=1100,height=800');
      if (!printWindow) {
        alert('Please allow popups to download the PDF.');
        return;
      }

      printWindow.document.write(printHtml);
      printWindow.document.close();

      // Wait for styles and content to load, then trigger print
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.focus();
          printWindow.print();
          // Close the print window after a short delay (user may cancel)
          setTimeout(() => {
            printWindow.close();
          }, 1000);
        }, 300);
      };
    } catch (err) {
      console.error('Failed to download PDF:', err);
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[4px] transition-all duration-500 ease-in-out animate-in fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-[95%] max-w-5xl max-h-[90vh] flex flex-col rounded-xl border border-slate-200 overflow-hidden animate-in zoom-in-95 slide-in-from-bottom-8 duration-500 fill-mode-forwards ease-out">
        {/* Compact Header */}
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 bg-slate-900 rounded-lg flex items-center justify-center">
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

          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadPdf}
              disabled={isDownloadingPdf}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white flex items-center gap-1.5 shadow-sm transition-all disabled:opacity-50"
              title="Download Strategy Configuration as PDF"
            >
              {isDownloadingPdf ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Generating PDF...</span>
                </>
              ) : (
                <>
                  <FileText className="h-3.5 w-3.5" />
                  <span>Download PDF</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-200 transition-all text-slate-500 hover:text-slate-900 bg-white border border-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
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
          <div ref={contentRef} className="p-3 w-full max-w-6xl mx-auto h-full bg-white rounded-lg">
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

