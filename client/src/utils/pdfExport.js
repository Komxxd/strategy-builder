import { jsPDF } from 'jspdf';

// ─── Colors ────────────────────────────────────
const COL = {
  black:   [15, 23, 42],
  gray:    [100, 116, 139],
  light:   [226, 232, 240],
  bg:      [248, 250, 252],
  white:   [255, 255, 255],
  indigo:  [99, 102, 241],
  green:   [16, 185, 129],
  red:     [239, 68, 68],
  blue:    [59, 130, 246],
  orange:  [249, 115, 22],
};

// ─── Helper: value pill (a bordered box with text) ──────
function pill(doc, x, y, w, text, { fontSize = 8, bold = false, color = COL.black } = {}) {
  doc.setDrawColor(...COL.light);
  doc.setFillColor(...COL.white);
  doc.roundedRect(x, y, w, 7, 1.2, 1.2, 'FD');
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(fontSize);
  doc.setTextColor(...color);
  doc.text(String(text ?? '—'), x + 2, y + 4.8);
}

// ─── Helper: section label ──────────────────────
function sectionLabel(doc, x, y, text) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...COL.gray);
  doc.text(text.toUpperCase(), x, y);
}

// ─── Helper: key-value row ──────────────────────
function kvRow(doc, x, y, label, value, opts = {}) {
  const { labelW = 28, valW = 28, color } = opts;
  sectionLabel(doc, x, y, label);
  pill(doc, x, y + 1.5, valW, value, { color });
  return y + 12;
}

// ─── Helper: section toggle label (no toggle graphic) ───
function togglePill(doc, x, y, label, enabled) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...(enabled ? COL.black : COL.gray));
  doc.text(label, x, y + 2.8);
}

// ─── Check if we need a new page ────────────────
function checkPage(doc, y, needed = 30) {
  if (y + needed > 280) {
    doc.addPage();
    return 15;
  }
  return y;
}

// ─── Build Leg Block ────────────────────────────
function renderLeg(doc, leg, legIndex, startY, pageW, { isLazy = false, lazyLevel = 0 } = {}) {
  let y = startY;
  const indent = isLazy ? 8 * lazyLevel : 0;
  const leftMargin = 15 + indent;
  const boxW = pageW - 30 - indent;

  y = checkPage(doc, y, 65);

  // Leg header bar
  const headerCol = isLazy ? COL.orange : COL.bg;
  const headerBorderCol = isLazy ? COL.orange : COL.light;
  doc.setFillColor(...(isLazy ? [255, 247, 237] : COL.bg)); // orange-50 for lazy
  doc.setDrawColor(...headerBorderCol);
  doc.roundedRect(leftMargin, y, boxW, 8, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  if (isLazy) {
    doc.setTextColor(...COL.orange);
    doc.text('L', leftMargin + 3.5, y + 5.3);
    doc.setTextColor(...COL.black);
    doc.text(`Lazy Leg (Level ${lazyLevel})`, leftMargin + 9, y + 5.3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.orange);
    doc.text('PLACED AFTER PARENT SL HITS', leftMargin + 48, y + 5.3);
  } else {
    doc.setTextColor(...COL.indigo);
    doc.text(`${legIndex + 1}`, leftMargin + 3.5, y + 5.3);
    doc.setTextColor(...COL.black);
    doc.text(`Strategy Leg ${legIndex + 1}`, leftMargin + 9, y + 5.3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.gray);
    doc.text('INITIAL ENTRY LEG', leftMargin + 42, y + 5.3);
  }
  y += 12;

  // Row 1: Expiry, Option Type, Strike Criteria, Strike/Premium
  const col1W = (boxW - 10) / 4;
  const fields1 = [
    { label: 'Expiry', value: (leg.expiry_type || 'weekly').replace(/_/g, ' ') },
    { label: 'Option Type', value: leg.option_type === 'CE' ? 'Call' : 'Put' },
    { label: 'Strike Criteria', value: (leg.strike_criteria || 'STRIKE_TYPE').replace(/_/g, ' ') },
  ];

  if (leg.strike_criteria === 'CLOSEST_PREMIUM') {
    fields1.push({ label: 'Premium (Rs)', value: leg.premium });
  } else {
    fields1.push({ label: 'Strike', value: leg.strike });
  }

  y = checkPage(doc, y, 15);
  fields1.forEach((f, i) => {
    const x = leftMargin + 2 + i * (col1W + 2.5);
    sectionLabel(doc, x, y, f.label);
    pill(doc, x, y + 1.5, col1W, f.value, { fontSize: 8, bold: true });
  });
  y += 13;

  // Row 2: Side, Lots
  y = checkPage(doc, y, 15);
  const sideColor = leg.side === 'BUY' ? COL.blue : COL.orange;
  sectionLabel(doc, leftMargin + 2, y, 'Side');
  pill(doc, leftMargin + 2, y + 1.5, 25, leg.side, { bold: true, color: sideColor });
  sectionLabel(doc, leftMargin + 32, y, 'Lots');
  pill(doc, leftMargin + 32, y + 1.5, 18, leg.lots, { bold: true });
  y += 14;

  // Stop Loss
  y = checkPage(doc, y, 18);
  togglePill(doc, leftMargin + 2, y, 'Stop Loss', leg.sl_enabled !== false);
  if (leg.sl_enabled !== false) {
    const slTypeLabel = (leg.sl_type || 'PERCENTAGE') === 'PERCENTAGE' ? 'Percentage(%)' : 'Points(Pts)';
    pill(doc, leftMargin + 40, y - 0.5, 28, slTypeLabel, { fontSize: 7 });
    pill(doc, leftMargin + 70, y - 0.5, 18, leg.stop_loss, { bold: true });
  }
  y += 9;

  // Trailing Stop Loss
  y = checkPage(doc, y, 18);
  togglePill(doc, leftMargin + 2, y, 'Trailing Stop Loss', leg.tsl_enabled || false);
  if (leg.tsl_enabled) {
    const tslTypeLabel = (leg.tsl_type || 'PERCENTAGE') === 'PERCENTAGE' ? 'Percentage(%)' : 'Points(Pts)';
    pill(doc, leftMargin + 45, y - 0.5, 28, tslTypeLabel, { fontSize: 7 });
    pill(doc, leftMargin + 75, y - 0.5, 14, leg.tsl_move, { bold: true });
    pill(doc, leftMargin + 91, y - 0.5, 14, leg.tsl_trail, { bold: true });
    if (leg.tsl_on_close) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...COL.gray);
      doc.text('☑ On Close', leftMargin + 108, y + 2.5);
    }
  }
  y += 10;

  // Simple Momentum
  y = checkPage(doc, y, 12);
  togglePill(doc, leftMargin + 2, y, 'Simple Momentum', leg.simple_mntm_enabled || false);
  if (leg.simple_mntm_enabled) {
    pill(doc, leftMargin + 45, y - 0.5, 30, (leg.simple_mntm_mode || '').replace(/_/g, ' '), { fontSize: 6.5 });
    pill(doc, leftMargin + 77, y - 0.5, 16, leg.simple_mntm_value, { bold: true });
  }
  y += 9;

  // RE-ENTRY
  y = checkPage(doc, y, 12);
  const reEnabled = leg.re_asap_enabled || leg.recost_enabled || leg.resl_enabled || leg.rehigh_enabled || leg.relow_enabled || leg.lazy_leg_enabled || false;
  togglePill(doc, leftMargin + 2, y, 'RE-ENTRY', reEnabled);
  if (reEnabled) {
    let reType = 'RE ASAP';
    if (leg.recost_enabled) reType = 'RE COST';
    if (leg.resl_enabled) reType = 'RE SL';
    if (leg.rehigh_enabled) reType = 'RE HIGH';
    if (leg.relow_enabled) reType = 'RE LOW';
    if (leg.lazy_leg_enabled) reType = 'LAZY LEG';
    pill(doc, leftMargin + 35, y - 0.5, 22, reType, { fontSize: 7, bold: true, color: COL.indigo });

    if (leg.re_asap_enabled) {
      pill(doc, leftMargin + 60, y - 0.5, 25, `Max: ${leg.re_asap_max_entries || 1}`, { fontSize: 7 });
    }
    if (leg.recost_enabled) {
      const rcMode = (leg.recost_mode || 'RECOST_PLUS_PCT').replace(/RECOST_/g, '').replace(/_/g, ' ');
      pill(doc, leftMargin + 60, y - 0.5, 22, rcMode, { fontSize: 6.5 });
      pill(doc, leftMargin + 84, y - 0.5, 14, leg.recost_value, { bold: true });
      pill(doc, leftMargin + 100, y - 0.5, 25, `Max: ${leg.max_reentry || 1}`, { fontSize: 7 });
    }
    if (leg.resl_enabled) {
      const rslMode = (leg.resl_mode || 'RESL_PLUS_PCT').replace(/RESL_/g, 'RE-SL ').replace(/_/g, ' ');
      pill(doc, leftMargin + 60, y - 0.5, 26, rslMode, { fontSize: 6.5 });
      pill(doc, leftMargin + 88, y - 0.5, 14, leg.resl_value, { bold: true });
      pill(doc, leftMargin + 104, y - 0.5, 25, `Max: ${leg.max_reentry || 1}`, { fontSize: 7 });
    }
    if (leg.rehigh_enabled) {
      const rhMode = (leg.rehigh_mode || 'REHIGH_MINUS_PTS').replace(/REHIGH_/g, '').replace(/_/g, ' ');
      pill(doc, leftMargin + 60, y - 0.5, 22, rhMode, { fontSize: 6.5 });
      pill(doc, leftMargin + 84, y - 0.5, 14, leg.rehigh_value, { bold: true });
      pill(doc, leftMargin + 100, y - 0.5, 25, `Max: ${leg.max_reentry || 1}`, { fontSize: 7 });
    }
    if (leg.relow_enabled) {
      const rlMode = (leg.relow_mode || 'RELOW_PLUS_PTS').replace(/RELOW_/g, '').replace(/_/g, ' ');
      pill(doc, leftMargin + 60, y - 0.5, 22, rlMode, { fontSize: 6.5 });
      pill(doc, leftMargin + 84, y - 0.5, 14, leg.relow_value, { bold: true });
      pill(doc, leftMargin + 100, y - 0.5, 25, `Max: ${leg.max_reentry || 1}`, { fontSize: 7 });
    }
  }
  y += 10;

  // Re-entry Momentum (for RE COST, RE SL, RE HIGH, RE LOW)
  const hasMntm = (leg.recost_enabled && leg.recost_mntm_enabled) ||
                  (leg.resl_enabled && leg.resl_mntm_enabled) ||
                  (leg.rehigh_enabled && leg.rehigh_mntm_enabled) ||
                  (leg.relow_enabled && leg.relow_mntm_enabled);
  if (hasMntm) {
    y = checkPage(doc, y, 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.gray);
    doc.text('RE-ENTRY MOMENTUM:', leftMargin + 4, y + 2.5);
    let mMode = '', mVal = '';
    if (leg.recost_mntm_enabled) { mMode = leg.recost_mntm_mode || ''; mVal = leg.recost_mntm_value; }
    if (leg.resl_mntm_enabled)   { mMode = leg.resl_mntm_mode || ''; mVal = leg.resl_mntm_value; }
    if (leg.rehigh_mntm_enabled) { mMode = leg.rehigh_mntm_mode || ''; mVal = leg.rehigh_mntm_value; }
    if (leg.relow_mntm_enabled)  { mMode = leg.relow_mntm_mode || ''; mVal = leg.relow_mntm_value; }
    pill(doc, leftMargin + 40, y - 0.5, 30, mMode.replace(/_/g, ' '), { fontSize: 6.5 });
    pill(doc, leftMargin + 72, y - 0.5, 14, mVal, { bold: true });
    y += 10;
  }

  // No Re-Entry on SL Candle
  if (reEnabled && leg.no_reentry_on_sl_candle) {
    y = checkPage(doc, y, 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.gray);
    doc.text('☑ No Re-Entry on SL Candle', leftMargin + 4, y + 2.5);
    y += 7;
  }

  // Override SL on Re-Entry
  if (leg.reentry_sl_enabled) {
    y = checkPage(doc, y, 12);
    togglePill(doc, leftMargin + 2, y, 'Override SL on Re-Entry', true);
    const rslType = (leg.reentry_sl_type || 'PERCENTAGE') === 'PERCENTAGE' ? '%' : 'Pts';
    pill(doc, leftMargin + 55, y - 0.5, 22, `${rslType}: ${leg.reentry_sl_value ?? '—'}`, { fontSize: 7, bold: true });
    y += 9;

    // Override TSL on Re-Entry
    if (leg.reentry_tsl_enabled) {
      y = checkPage(doc, y, 12);
      togglePill(doc, leftMargin + 2, y, 'Override TSL on Re-Entry', true);
      const rtslType = (leg.reentry_tsl_type || 'PERCENTAGE') === 'PERCENTAGE' ? '%' : 'Pts';
      pill(doc, leftMargin + 58, y - 0.5, 18, `${rtslType}`, { fontSize: 7 });
      pill(doc, leftMargin + 78, y - 0.5, 14, leg.reentry_tsl_move, { bold: true });
      pill(doc, leftMargin + 94, y - 0.5, 14, leg.reentry_tsl_trail, { bold: true });
      if (leg.reentry_tsl_on_close) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(...COL.gray);
        doc.text('☑ On Close', leftMargin + 111, y + 2.5);
      }
      y += 9;
    }
  }

  // ── Recursive Lazy Leg ──────────────────────
  if (leg.lazy_leg_enabled && leg.lazy_leg) {
    y += 2;
    y = renderLeg(doc, leg.lazy_leg, legIndex, y, pageW, {
      isLazy: true,
      lazyLevel: lazyLevel + 1
    });
  }

  return y;
}

// ═══════════════════════════════════════════════
//  Main Export Function
// ═══════════════════════════════════════════════
export async function downloadElementAsPdf(element, title = 'Strategy_Configuration') {
  // We read config from the StrategyConfigModal's props, passed via element.dataset
  // But since the caller passes the element ref, we need the config.
  // This function is called from StrategyConfigModal which has the config.
  // We'll use window.__pdfExportConfig as a bridge.
  const config = window.__pdfExportConfig;
  if (!config) {
    throw new Error('No strategy configuration data available for PDF export');
  }

  const doc = new jsPDF('p', 'mm', 'a4');
  const pageW = 210;
  let y = 15;

  // ── Document Header ───────────────────────
  doc.setFillColor(...COL.indigo);
  doc.rect(15, y, pageW - 30, 1, 'F');
  y += 4;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COL.black);
  doc.text(title, 15, y + 5);

  doc.setFillColor(...COL.indigo);
  doc.rect(15, y + 9, pageW - 30, 0.4, 'F');
  y += 15;

  // ── General Settings ──────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COL.black);
  doc.text('GENERAL SETTINGS', 15, y);
  y += 4;

  // Row: Name, Index, Limit Offset
  const gFields = [
    { label: 'Strategy Name', value: config.name || '—', w: 55 },
    { label: 'Index', value: config.index || '—', w: 22 },
    { label: 'Limit Offset', value: `${config.entry_limit_offset_type === 'PERCENTAGE' ? '%' : 'Pts'} ${config.entry_limit_offset ?? 0}`, w: 26 },
    { label: 'Chase Time (s)', value: config.chase_time_seconds ?? '—', w: 22 },
    { label: 'Entry Time', value: config.entry_time || '—', w: 22 },
  ];
  let gx = 15;
  gFields.forEach(f => {
    sectionLabel(doc, gx, y, f.label);
    pill(doc, gx, y + 1.5, f.w, f.value, { bold: true });
    gx += f.w + 3;
  });
  y += 14;

  // Exit Time
  sectionLabel(doc, 15, y, 'Exit Time');
  pill(doc, 15, y + 1.5, 22, config.exit_time || '—', { bold: true });
  y += 14;

  // ── Overall Risk Management ───────────────
  y = checkPage(doc, y, 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COL.black);
  doc.text('RISK MANAGEMENT', 15, y);
  y += 5;

  // Overall SL
  togglePill(doc, 15, y, 'Overall Stop Loss', config.overall_sl_enabled);
  if (config.overall_sl_enabled) {
    const slType = (config.overall_sl_type || 'PERCENTAGE') === 'PERCENTAGE' ? 'Percentage (%)' : 'Amount (Rs)';
    pill(doc, 55, y - 0.5, 28, slType, { fontSize: 7 });
    pill(doc, 85, y - 0.5, 18, config.overall_sl_value, { bold: true });
    if (config.overall_sl_on_close) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...COL.gray);
      doc.text('☑ On Close', 106, y + 2.5);
    }
  }
  y += 9;

  // Overall Target
  togglePill(doc, 15, y, 'Overall Target', config.overall_target_enabled);
  if (config.overall_target_enabled) {
    const tgtType = (config.overall_target_type || 'PERCENTAGE') === 'PERCENTAGE' ? 'Percentage (%)' : 'Amount (Rs)';
    pill(doc, 55, y - 0.5, 28, tgtType, { fontSize: 7 });
    pill(doc, 85, y - 0.5, 18, config.overall_target_value, { bold: true });
    if (config.overall_target_on_close) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...COL.gray);
      doc.text('☑ On Close', 106, y + 2.5);
    }
  }
  y += 14;

  // ── Strategy Legs ─────────────────────────
  y = checkPage(doc, y, 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COL.black);
  doc.text(`STRATEGY LEGS (${(config.legs || []).length})`, 15, y);
  y += 5;

  (config.legs || []).forEach((leg, i) => {
    y = renderLeg(doc, leg, i, y, pageW);
    y += 3;
  });

  // ── Footer ────────────────────────────────
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...COL.gray);
    doc.text(`Page ${i} of ${pageCount}`, pageW / 2, 290, { align: 'center' });
    doc.setFillColor(...COL.light);
    doc.rect(15, 287, pageW - 30, 0.3, 'F');
  }

  // ── Save ──────────────────────────────────
  const sanitizedName = title.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  doc.save(`${sanitizedName}_config.pdf`);
}
