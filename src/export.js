const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { hhmm } = require('./rules');

function br(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

const COLS = [
  { key: 'date', label: 'Data', w: 52 },
  { key: 'weekday', label: 'Dia', w: 28 },
  { key: 'punches', label: 'Marcações', w: 150 },
  { key: 'expected', label: 'Previsto', w: 46 },
  { key: 'worked', label: 'Trabalhado', w: 52 },
  { key: 'breakTotal', label: 'Intervalo', w: 46 },
  { key: 'overtime50', label: 'HE 50%', w: 42 },
  { key: 'overtime100', label: 'HE 100%', w: 44 },
  { key: 'deficit', label: 'Débito', w: 40 },
  { key: 'late', label: 'Atraso', w: 40 },
  { key: 'night', label: 'Noturno', w: 42 },
  { key: 'alerts', label: 'Ocorrências', w: 200 },
];

function rowValues(d) {
  const t = v => (v ? hhmm(v) : '');
  return {
    date: br(d.day),
    weekday: d.weekday,
    punches: d.punches.map(p => p.time).join('  '),
    expected: t(d.expected),
    worked: t(d.worked),
    breakTotal: t(d.breakTotal),
    overtime50: t(d.overtime50),
    overtime100: t(d.overtime100),
    deficit: t(d.deficit),
    late: t(d.late),
    night: t(d.night),
    alerts: dayNotesText(d),
  };
}

function noteText(n) {
  return `${n.kind}${n.excused ? ' (abonado)' : ''}${n.note ? `: ${n.note}` : ''}`;
}

function dayNotesText(d) {
  return [
    d.holiday ? `Feriado: ${d.holiday}` : null,
    d.vacation ? 'Férias' : null,
    d.special && !d.vacation ? `Jornada especial: ${d.special}${d.scheduleStart ? ` (${d.scheduleStart}–${d.scheduleEnd})` : ''}` : null,
    ...d.alerts,
    ...(d.notes || []).map(noteText),
  ].filter(Boolean).join('; ');
}

function totalLines(r) {
  const t = r.totals;
  return [
    ['Horas previstas', hhmm(t.expected)],
    ['Horas trabalhadas', hhmm(t.worked)],
    [`Hora extra ${r.rates.weekday}%`, hhmm(t.overtime50)],
    [`Hora extra ${r.rates.sunday}% (domingos/feriados)`, hhmm(t.overtime100)],
    ['Horas em débito', hhmm(t.deficit)],
    ['Saldo (banco de horas)', hhmm(t.balance)],
    ['Adicional noturno (22h–5h)', hhmm(t.night)],
    ['Intervalo suprimido', hhmm(t.breakMissing)],
    ['Atrasos', `${hhmm(t.late)} em ${t.lateDays} dia(s)`],
    ['Saídas antecipadas', hhmm(t.early)],
    ['Faltas', String(t.absences)],
  ];
}

function buildPdf(reports, res) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.pipe(res);

  reports.forEach((r, idx) => {
    if (idx > 0) doc.addPage();
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#6f55c9').text(r.company).fillColor('black');
    doc.moveTo(doc.page.margins.left, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).lineWidth(2).strokeColor('#ffda67').stroke();
    doc.moveDown(0.4);
    doc.fontSize(11).font('Helvetica')
      .text(`Espelho de ponto: ${r.employee.name}`)
      .text(`Período: ${br(r.from)} a ${br(r.to)}`);
    doc.moveDown(0.6);

    const x0 = doc.page.margins.left;
    let y = doc.y;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(8);
      let x = x0;
      doc.rect(x0, y - 2, COLS.reduce((a, c) => a + c.w, 0), 14).fill('#f1ecfe').fillColor('black');
      for (const c of COLS) { doc.text(c.label, x + 2, y + 1, { width: c.w - 4 }); x += c.w; }
      y += 14;
      doc.font('Helvetica').fontSize(8);
    };
    header();

    for (const d of r.days) {
      const v = rowValues(d);
      const h = Math.max(12, doc.heightOfString(v.alerts, { width: COLS[COLS.length - 1].w - 4 }) + 3);
      if (y + h > doc.page.height - doc.page.margins.bottom - 10) { doc.addPage(); y = doc.page.margins.top; header(); }
      if (d.alerts.length) doc.fillColor('#c2185b'); else if (d.expected === 0) doc.fillColor('#777'); else doc.fillColor('black');
      let x = x0;
      for (const c of COLS) { doc.text(v[c.key], x + 2, y + 1, { width: c.w - 4 }); x += c.w; }
      doc.fillColor('black');
      y += h;
      doc.moveTo(x0, y - 1).lineTo(x, y - 1).lineWidth(0.3).strokeColor('#ccc').stroke();
    }

    y += 10;
    if (y + 130 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica-Bold').fontSize(10).text('Totais do período', x0, y); y += 16;
    doc.font('Helvetica').fontSize(9);
    for (const [k, v] of totalLines(r)) { doc.text(k, x0, y, { width: 200 }); doc.text(v, x0 + 200, y); y += 12; }

    y += 30;
    if (y + 30 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top + 30; }
    doc.moveTo(x0, y).lineTo(x0 + 220, y).stroke('black');
    doc.moveTo(x0 + 300, y).lineTo(x0 + 520, y).stroke('black');
    doc.text('Assinatura do funcionário', x0, y + 4, { width: 220, align: 'center' });
    doc.text('Assinatura do responsável', x0 + 300, y + 4, { width: 220, align: 'center' });
  });

  doc.end();
}

async function buildXlsx(reports, res) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stazzy Ponto';

  // Aba resumo com uma linha por funcionário.
  const summary = wb.addWorksheet('Resumo');
  summary.columns = [
    { header: 'Funcionário', key: 'name', width: 28 },
    { header: 'Previsto', key: 'expected', width: 11 },
    { header: 'Trabalhado', key: 'worked', width: 11 },
    { header: 'HE 50%', key: 'o50', width: 10 },
    { header: 'HE 100%', key: 'o100', width: 10 },
    { header: 'Débito', key: 'deficit', width: 10 },
    { header: 'Saldo', key: 'balance', width: 10 },
    { header: 'Noturno', key: 'night', width: 10 },
    { header: 'Intervalo suprimido', key: 'bm', width: 18 },
    { header: 'Faltas', key: 'abs', width: 8 },
    { header: 'Dias com ocorrência', key: 'ad', width: 18 },
  ];
  for (const r of reports) {
    const t = r.totals;
    summary.addRow({
      name: r.employee.name, expected: hhmm(t.expected), worked: hhmm(t.worked),
      o50: hhmm(t.overtime50), o100: hhmm(t.overtime100), deficit: hhmm(t.deficit),
      balance: hhmm(t.balance), night: hhmm(t.night), bm: hhmm(t.breakMissing),
      abs: t.absences, ad: t.alertDays,
    });
  }
  summary.getRow(1).font = { bold: true, color: { argb: 'FF6F55C9' } };
  summary.getRow(1).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1ECFE' } }; });

  const used = new Set();
  for (const r of reports) {
    let name = r.employee.name.replace(/[\\/?*[\]:]/g, '').slice(0, 28) || `Func ${r.employee.id}`;
    while (used.has(name)) name += '_';
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([`${r.company} — Espelho de ponto: ${r.employee.name}`]).font = { bold: true, size: 13 };
    ws.addRow([`Período: ${br(r.from)} a ${br(r.to)}`]);
    ws.addRow([]);
    const hdr = ws.addRow(COLS.map(c => c.label));
    hdr.font = { bold: true, color: { argb: 'FF6F55C9' } };
    hdr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1ECFE' } }; });
    for (const d of r.days) {
      const v = rowValues(d);
      const row = ws.addRow(COLS.map(c => v[c.key]));
      if (d.alerts.length) row.font = { color: { argb: 'FFC2185B' } };
    }
    ws.addRow([]);
    ws.addRow(['Totais do período']).font = { bold: true };
    for (const [k, v] of totalLines(r)) ws.addRow([k, '', v]);
    COLS.forEach((c, i) => { ws.getColumn(i + 1).width = Math.round(c.w / 5.5); });
  }

  await wb.xlsx.write(res);
  res.end();
}

// ---------- registro de ocorrências ----------
const OCC_COLS = [
  { key: 'date', label: 'Data', w: 56 },
  { key: 'weekday', label: 'Dia', w: 28 },
  { key: 'name', label: 'Funcionário', w: 110 },
  { key: 'schedule', label: 'Jornada prevista', w: 70 },
  { key: 'punches', label: 'Marcações', w: 120 },
  { key: 'alerts', label: 'Ocorrências', w: 220 },
  { key: 'notes', label: 'Justificativa', w: 178 },
];

function occValues(r) {
  return {
    date: br(r.day), weekday: r.weekday, name: r.employee.name,
    schedule: r.scheduleStart ? `${r.scheduleStart}–${r.scheduleEnd}` : (r.special || 'Folga'),
    punches: r.punches.map(p => p.time).join('  '),
    alerts: [r.special && !r.vacation ? `Jornada especial: ${r.special}` : (r.vacation ? 'Férias' : null), ...r.alerts].filter(Boolean).join('; '),
    notes: r.notes.map(noteText).join('; '),
  };
}

function buildOccurrencesPdf(o, res) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.pipe(res);
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#6f55c9').text(o.company).fillColor('black');
  doc.moveTo(doc.page.margins.left, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).lineWidth(2).strokeColor('#ffda67').stroke();
  doc.moveDown(0.4);
  doc.fontSize(11).font('Helvetica').text('Registro de jornadas com ocorrências').text(`Período: ${br(o.from)} a ${br(o.to)}`);
  doc.moveDown(0.6);
  const x0 = doc.page.margins.left;
  const width = OCC_COLS.reduce((a, c) => a + c.w, 0);
  let y = doc.y;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(8);
    doc.rect(x0, y - 2, width, 14).fill('#f1ecfe').fillColor('black');
    let x = x0;
    for (const c of OCC_COLS) { doc.text(c.label, x + 2, y + 1, { width: c.w - 4 }); x += c.w; }
    y += 14;
    doc.font('Helvetica').fontSize(8);
  };
  header();
  if (!o.rows.length) doc.text('Nenhuma ocorrência no período.', x0, y + 4);
  for (const r of o.rows) {
    const v = occValues(r);
    const h = Math.max(12, ...OCC_COLS.map(c => doc.heightOfString(v[c.key] || ' ', { width: c.w - 4 }))) + 3;
    if (y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top; header(); }
    let x = x0;
    for (const c of OCC_COLS) {
      doc.fillColor(c.key === 'alerts' && r.alerts.length ? '#c2185b' : 'black').text(v[c.key], x + 2, y + 1, { width: c.w - 4 });
      x += c.w;
    }
    doc.fillColor('black');
    y += h;
    doc.moveTo(x0, y - 1).lineTo(x0 + width, y - 1).lineWidth(0.3).strokeColor('#ccc').stroke();
  }
  doc.end();
}

async function buildOccurrencesXlsx(o, res) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Stazzy Ponto';
  const ws = wb.addWorksheet('Ocorrências');
  ws.addRow([`${o.company} — Registro de jornadas com ocorrências`]).font = { bold: true, size: 13 };
  ws.addRow([`Período: ${br(o.from)} a ${br(o.to)}`]);
  ws.addRow([]);
  const hdr = ws.addRow(OCC_COLS.map(c => c.label));
  hdr.font = { bold: true, color: { argb: 'FF6F55C9' } };
  hdr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1ECFE' } }; });
  for (const r of o.rows) {
    const v = occValues(r);
    ws.addRow(OCC_COLS.map(c => v[c.key]));
  }
  OCC_COLS.forEach((c, i) => { ws.getColumn(i + 1).width = Math.round(c.w / 5); });
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { buildPdf, buildXlsx, buildOccurrencesPdf, buildOccurrencesXlsx };
