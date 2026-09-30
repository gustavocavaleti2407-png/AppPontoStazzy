// Regras de jornada, intervalo e hora extra (baseadas na CLT; valores configuráveis em Configurações).
const { db, getSettings } = require('./db');

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function pad(n) { return String(n).padStart(2, '0'); }

function localDay(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localIso(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function hhmm(min) {
  const sign = min < 0 ? '-' : '';
  const m = Math.abs(Math.round(min));
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function timeOf(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseHM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function eachDay(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (d <= end) { out.push(localDay(d)); d.setDate(d.getDate() + 1); }
  return out;
}

// Minutos do intervalo [a, b) que caem no período noturno (padrão 22h–5h).
function nightMinutes(a, b, s) {
  const ns = parseHM(s.night_start), ne = parseHM(s.night_end);
  let total = 0;
  const step = 60 * 1000;
  for (let t = a.getTime(); t < b.getTime(); t += step) {
    const d = new Date(t);
    const m = d.getHours() * 60 + d.getMinutes();
    const isNight = ns > ne ? (m >= ns || m < ne) : (m >= ns && m < ne);
    if (isNight) total++;
  }
  return total;
}

function expectedMinutes(emp, day, holidays) {
  if (holidays[day]) return 0;
  const wd = new Date(`${day}T12:00:00`).getDay();
  const days = emp.work_days.split(',').map(Number);
  if (!days.includes(wd)) return 0;
  return wd === 6 ? emp.saturday_minutes : emp.daily_minutes;
}

/**
 * Calcula um dia de trabalho a partir das marcações.
 * Marcações são pareadas em ordem: entrada, saída, entrada, saída...
 */
function computeDay(emp, day, punches, prevLastPunch, holidays, s) {
  const tolDaily = Number(s.tolerance_daily);
  const wd = new Date(`${day}T12:00:00`).getDay();
  const isHoliday = !!holidays[day];
  const isSundayOrHoliday = wd === 0 || isHoliday;
  const expected = expectedMinutes(emp, day, holidays);

  const times = punches.map(p => new Date(p.ts));
  const alerts = [];
  let worked = 0, night = 0;
  const breaks = [];

  for (let i = 0; i + 1 < times.length; i += 2) {
    worked += (times[i + 1] - times[i]) / 60000;
    night += nightMinutes(times[i], times[i + 1], s);
    if (i + 2 < times.length) breaks.push((times[i + 2] - times[i + 1]) / 60000);
  }
  worked = Math.round(worked);
  const breakTotal = Math.round(breaks.reduce((a, b) => a + b, 0));

  const isPast = day < localDay(new Date());
  if (times.length % 2 === 1 && isPast) alerts.push('Marcação ímpar: falta registrar uma saída');

  // Tolerância (art. 58 §1º): diferenças de até N min no dia não são computadas.
  let diff = worked - expected;
  if (Math.abs(diff) <= tolDaily) diff = 0;
  const overtime = Math.max(0, diff);
  // Débito só é apurado depois que o dia termina.
  const deficit = expected > 0 && isPast ? Math.max(0, -diff) : 0;
  const overtime50 = isSundayOrHoliday ? 0 : overtime;
  const overtime100 = isSundayOrHoliday ? overtime : 0;

  if (overtime > Number(s.max_daily_overtime)) {
    alerts.push(`Hora extra acima do limite diário (${hhmm(Number(s.max_daily_overtime))})`);
  }

  // Intervalo intrajornada (art. 71).
  let breakMissing = 0;
  if (worked > 360) {
    const min = Number(s.min_break_long);
    if (breakTotal < min) {
      breakMissing = min - breakTotal;
      alerts.push(`Intervalo insuficiente: ${hhmm(breakTotal)} de ${hhmm(min)} obrigatórios`);
    }
    if (breakTotal > 120) alerts.push('Intervalo acima de 2h');
  } else if (worked > 240) {
    const min = Number(s.min_break_short);
    if (breakTotal < min) {
      breakMissing = min - breakTotal;
      alerts.push(`Intervalo insuficiente: ${hhmm(breakTotal)} de ${hhmm(min)} obrigatórios`);
    }
  }

  // Interjornada (art. 66): mínimo de 11h entre jornadas.
  if (times.length && prevLastPunch) {
    const gap = (times[0] - new Date(prevLastPunch)) / 60000;
    if (gap < Number(s.min_interjornada)) {
      alerts.push(`Interjornada de ${hhmm(gap)} (mínimo ${hhmm(Number(s.min_interjornada))})`);
    }
  }

  if (expected > 0 && times.length === 0 && isPast) alerts.push('Falta');

  return {
    day,
    weekday: WEEKDAYS[wd],
    holiday: holidays[day] || null,
    punches: punches.map(p => ({ id: p.id, ts: p.ts, time: timeOf(p.ts), source: p.source })),
    expected, worked, breakTotal, breakMissing,
    overtime50, overtime100, deficit, night,
    balance: overtime - deficit,
    alerts,
  };
}

async function holidayMap() {
  const out = {};
  for (const h of await db.all('SELECT day, name FROM holidays')) out[h.day] = h.name;
  return out;
}

async function computeReport(employeeId, from, to) {
  const s = await getSettings();
  const emp = await db.get('SELECT * FROM employees WHERE id = ?', [employeeId]);
  if (!emp) throw Object.assign(new Error('Funcionário não encontrado'), { status: 404 });
  const holidays = await holidayMap();

  const rows = await db.all(
    'SELECT id, ts, day, source FROM punches WHERE employee_id = ? AND deleted = 0 AND day BETWEEN ? AND ? ORDER BY ts',
    [employeeId, from, to]);
  const byDay = {};
  for (const r of rows) (byDay[r.day] ||= []).push(r);

  let prevLast = (await db.get(
    'SELECT ts FROM punches WHERE employee_id = ? AND deleted = 0 AND day < ? ORDER BY ts DESC LIMIT 1',
    [employeeId, from]))?.ts || null;

  const days = [];
  for (const day of eachDay(from, to)) {
    const p = byDay[day] || [];
    days.push(computeDay(emp, day, p, prevLast, holidays, s));
    if (p.length) prevLast = p[p.length - 1].ts;
  }

  const sum = k => days.reduce((a, d) => a + d[k], 0);
  const totals = {
    expected: sum('expected'), worked: sum('worked'),
    overtime50: sum('overtime50'), overtime100: sum('overtime100'),
    deficit: sum('deficit'), night: sum('night'), breakMissing: sum('breakMissing'),
    balance: sum('balance'),
    absences: days.filter(d => d.alerts.includes('Falta')).length,
    alertDays: days.filter(d => d.alerts.length).length,
  };

  return {
    employee: { id: emp.id, name: emp.name, login: emp.login, daily_minutes: emp.daily_minutes },
    company: s.company_name,
    from, to, days, totals,
    rates: { weekday: Number(s.overtime_rate_weekday), sunday: Number(s.overtime_rate_sunday) },
  };
}

module.exports = { computeReport, localDay, localIso, hhmm, eachDay };
