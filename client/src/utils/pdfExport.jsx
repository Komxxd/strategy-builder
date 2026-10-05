import React from 'react';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import { createRoot } from 'react-dom/client';
import { toPng } from 'html-to-image';
import { StrategyFormContent } from '../components/StrategyBuilder';

const sanitizeFileName = (name) =>
  String(name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function buildStrategyPdf(config, title = 'Strategy_Configuration') {
  if (!config) {
    throw new Error('No strategy configuration data available for PDF export');
  }

  // Create an off-screen container but within viewport to ensure browser paints it
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.zIndex = '-9999';
  container.style.opacity = '1'; // Must be 1 so html-to-image captures it!
  container.style.width = '1100px'; 
  container.style.background = 'white';
  document.body.appendChild(container);

  const root = createRoot(container);

  await new Promise(resolve => {
    root.render(
      <div style={{ maxWidth: '1100px', margin: '0 auto', background: 'white', padding: '16px' }}>
        <div style={{ padding: '12px 0 16px 0', borderBottom: '2px solid #6366f1', marginBottom: '16px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a', margin: '0 0 4px 0', fontFamily: 'system-ui, sans-serif' }}>
            Strategy Configuration
          </h1>
          <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0, fontFamily: 'system-ui, sans-serif' }}>
            {title}
          </p>
        </div>
        <div className="p-3 w-full bg-white rounded-lg">
          <StrategyFormContent config={config} isReadOnly={true} />
        </div>
      </div>
    );
    // Give it time to render and apply Tailwind classes
    setTimeout(resolve, 600); 
  });

  const imgData = await toPng(container, {
    pixelRatio: 2,
    skipFonts: true, // Prevents hanging on remote fonts
    backgroundColor: 'white',
    filter: (node) => {
      // Don't try to inline external stylesheets or scripts
      if (node.tagName === 'LINK' || node.tagName === 'link') return false;
      if (node.tagName === 'SCRIPT' || node.tagName === 'script') return false;
      return true;
    }
  });

  // Calculate dimensions for jsPDF. html-to-image doesn't return a canvas directly, it returns a data URL.
  // We need to load it into an image to get the natural dimensions for jsPDF slicing.
  const img = new Image();
  img.src = imgData;
  await new Promise(resolve => { img.onload = resolve; });
  
  if (img.height === 0 || img.width === 0) {
    alert(`Debug: Image height is 0! Container offsetHeight was ${container.offsetHeight}, innerHTML length was ${container.innerHTML.length}`);
  }

  root.unmount();
  document.body.removeChild(container);

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pdfWidth = 210;
  const pageHeight = 297;
  const imgHeight = (img.height * pdfWidth) / img.width;
  let heightLeft = imgHeight;
  let position = 0;

  pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
  heightLeft -= pageHeight;

  while (heightLeft > 0) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  return pdf;
}

export async function downloadElementAsPdf(element, title = 'Strategy_Configuration') {
  const doc = await buildStrategyPdf(window.__pdfExportConfig, title);
  const sanitizedName = title.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  doc.save(`${sanitizedName}_config.pdf`);
}

export async function downloadStrategiesAsZip(items, zipName = 'strategies', onProgress) {
  if (!items || items.length === 0) {
    throw new Error('No strategies to export');
  }

  const zip = new JSZip();
  const usedPaths = new Set();
  const failed = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = item.name || item.config?.name || 'Strategy';
    try {
      const doc = await buildStrategyPdf(item.config, title);
      const folderPath = (item.path || []).map(sanitizeFileName).join('/');
      const base = sanitizeFileName(title);

      let candidate = `${folderPath ? folderPath + '/' : ''}${base}.pdf`;
      let n = 2;
      while (usedPaths.has(candidate.toLowerCase())) {
        candidate = `${folderPath ? folderPath + '/' : ''}${base} (${n++}).pdf`;
      }
      usedPaths.add(candidate.toLowerCase());

      zip.file(candidate, doc.output('arraybuffer'));
    } catch (err) {
      console.error(`Failed to generate PDF for "${title}":`, err);
      alert(`Error for ${title}: ${err.message}\n${err.stack}`);
      failed.push(title);
    }
    if (onProgress) onProgress(i + 1, items.length);
  }

  if (failed.length === items.length) {
    throw new Error('Failed to generate any PDFs');
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  triggerBlobDownload(blob, `${sanitizeFileName(zipName)}.zip`);
  return { total: items.length, failed };
}
