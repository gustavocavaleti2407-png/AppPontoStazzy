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

function span(start, end) {
  let m = parseHM(end) - parseHM(start);
  if (m < 0) m += 1440; // jornada que passa da meia-noite
  return m;
}

/**
 * Jornada prevista do dia: uma jornada especial cadastrada para o dia vale mais que tudo;
 * depois feriado, dia de folga da escala, sábado e, por fim, o horário padrão do funcionário.
 */
function scheduleFor(emp, day, holidays, exceptions) {
  const ex = exceptions.find(e => e.day === day && e.employee_id === emp.id)
    || exceptions.find(e => e.day === day && e.employee_id == null);
  if (ex) {
    if (ex.vacation) return { expected: 0, start: null, end: null, special: 'Férias', vacation: true };
    if (ex.day_off || !ex.start_time || !ex.end_time) return { expected: 0, start: null, end: null, special: ex.reason || 'Folga' };
    return { expected: Math.max(0, span(ex.start_time, ex.end_time) - ex.break_minutes),
      start: ex.start_time, end: ex.end_time, special: ex.reason || 'Jornada especial' };
  }
  if (holidays[day]) return { expected: 0, start: null, end: null };
  const wd = new Date(`${day}T12:00:00`).getDay();
  if (!emp.work_days.split(',').map(Number).includes(wd)) return { expected: 0, start: null, end: null };
  if (wd === 6) return { expected: span(emp.sat_start, emp.sat_end), start: emp.sat_start, end: emp.sat_end };
  return { expected: Math.max(0, span(emp.start_time, emp.end_time) - emp.break_minutes), start: emp.start_time, end: emp.end_time };
}

/**
 * Calcula um dia de trabalho a partir das marcações.
 * Marcações são pareadas em ordem: entrada, saída, entrada, saída...
 */
function computeDay(emp, day, punches, prevLastPunch, holidays, s, exceptions, notes) {
  const tolDaily = Number(s.tolerance_daily);
  const wd = new Date(`${day}T12:00:00`).getDay();
  const isHoliday = !!holidays[day];
  const isSundayOrHoliday = wd === 0 || isHoliday;
  const sched = scheduleFor(emp, day, holidays, exceptions);
  const expected = sched.expected;
  const dayNotes = notes.filter(n => n.day === day);
  const excused = dayNotes.some(n => n.excused);
  const lateTol = Number(s.late_tolerance);

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

  // Atraso na entrada e saída antecipada em relação ao horário previsto.
  let late = 0, early = 0;
  if (sched.start && times.length) {
    const first = times[0].getHours() * 60 + times[0].getMinutes();
    const m = first - parseHM(sched.start);
    if (m > lateTol) late = m;
  }
  if (sched.end && times.length >= 2 && times.length % 2 === 0) {
    const lastT = times[times.length - 1];
    const lastMin = (lastT - new Date(`${day}T00:00:00`)) / 60000;
    let endMin = parseHM(sched.end);
    if (sched.start && endMin < parseHM(sched.start)) endMin += 1440;
    const m = Math.round(endMin - lastMin);
    if (m > lateTol) early = m;
  }
  if (excused) { late = 0; early = 0; }
  if (late) alerts.push(`Atraso de ${hhmm(late)} (entrada prevista ${sched.start})`);
  if (early) alerts.push(`Saída antecipada de ${hhmm(early)} (saída prevista ${sched.end})`);

  // Tolerância (art. 58 §1º): diferenças de até N min no dia não são computadas.
  let diff = worked - expected;
  if (Math.abs(diff) <= tolDaily) diff = 0;
  const overtime = Math.max(0, diff);
  // Débito só é apurado depois que o dia termina; dia abonado não gera débito.
  const deficit = expected > 0 && isPast && !excused ? Math.max(0, -diff) : 0;
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

  if (expected > 0 && times.length === 0 && isPast && !excused) alerts.push('Falta');

  return {
    day,
    weekday: WEEKDAYS[wd],
    holiday: holidays[day] || null,
    special: sched.special || null,
    vacation: !!sched.vacation,
    scheduleStart: sched.start, scheduleEnd: sched.end,
    notes: dayNotes.map(n => ({ id: n.id, kind: n.kind, note: n.note, excused: !!n.excused })),
    excused, late, early,
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
  const exceptions = await db.all(
    'SELECT * FROM schedule_exceptions WHERE day BETWEEN ? AND ? AND (employee_id = ? OR employee_id IS NULL) ORDER BY id DESC',
    [from, to, employeeId]);
  const notes = await db.all('SELECT * FROM day_notes WHERE employee_id = ? AND day BETWEEN ? AND ? ORDER BY id',
    [employeeId, from, to]);
  // Férias aprovadas valem mais que qualquer jornada: entram na frente da lista de jornadas especiais.
  const vacations = await db.all(
    `SELECT start_day, end_day FROM vacation_requests WHERE employee_id = ? AND status = 'aprovado'
     AND start_day IS NOT NULL AND start_day <= ? AND end_day >= ?`, [employeeId, to, from]);
  for (const v of vacations) {
    for (const day of eachDay(v.start_day > from ? v.start_day : from, v.end_day < to ? v.end_day : to)) {
      exceptions.unshift({ day, employee_id: emp.id, vacation: true });
    }
  }

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
    days.push(computeDay(emp, day, p, prevLast, holidays, s, exceptions, notes));
    if (p.length) prevLast = p[p.length - 1].ts;
  }

  const sum = k => days.reduce((a, d) => a + d[k], 0);
  const totals = {
    expected: sum('expected'), worked: sum('worked'),
    overtime50: sum('overtime50'), overtime100: sum('overtime100'),
    deficit: sum('deficit'), night: sum('night'), breakMissing: sum('breakMissing'),
    late: sum('late'), early: sum('early'), lateDays: days.filter(d => d.late).length,
    balance: sum('balance'),
    absences: days.filter(d => d.alerts.includes('Falta')).length,
    alertDays: days.filter(d => d.alerts.length).length,
    vacationDays: days.filter(d => d.vacation).length,
  };

  return {
    employee: { id: emp.id, name: emp.name, login: emp.login, daily_minutes: emp.daily_minutes },
    company: s.company_name,
    from, to, days, totals,
    rates: { weekday: Number(s.overtime_rate_weekday), sunday: Number(s.overtime_rate_sunday) },
  };
}

module.exports = { computeReport, localDay, localIso, hhmm, eachDay, timeOf };
