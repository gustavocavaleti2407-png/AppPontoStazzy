// Férias (CLT arts. 129–145): a cada 12 meses de trabalho (período aquisitivo) o funcionário
// ganha 30 dias, que devem ser tirados nos 12 meses seguintes (período concessivo).
// Pode vender até 1/3 (10 dias) e dividir em até 3 períodos, um com 14 dias ou mais e os outros com 5 ou mais.
const { db } = require('./db');
const { localDay, eachDay } = require('./rules');

const DAYS_PER_PERIOD = 30;
const MAX_SELL = 10;
const MIN_PERIOD_DAYS = 5;

function addYears(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y + n, m - 1, d, 12);
  if (dt.getMonth() !== m - 1) dt.setDate(0); // 29/02 em ano não bissexto vira 28/02
  return localDay(dt);
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

/** Saldo de férias de um funcionário na data de hoje. */
async function vacationSummary(emp) {
  const today = localDay(new Date());
  const reqs = await db.all(
    "SELECT * FROM vacation_requests WHERE employee_id = ? AND status IN ('aprovado', 'pendente') ORDER BY start_day, id", [emp.id]);
  const adjustments = await db.all('SELECT * FROM vacation_adjustments WHERE employee_id = ? ORDER BY id', [emp.id]);
  const approved = reqs.filter(r => r.status === 'aprovado');
  const pending = reqs.filter(r => r.status === 'pendente');

  const used = approved.reduce((a, r) => a + Number(r.days), 0);
  const sold = approved.reduce((a, r) => a + Number(r.sell_days), 0);
  const reserved = pending.reduce((a, r) => a + Number(r.days) + Number(r.sell_days), 0);
  const adjust = adjustments.reduce((a, r) => a + Number(r.days), 0);

  const out = {
    employee: { id: emp.id, name: emp.name, hire_date: emp.hire_date || null },
    used, sold, reserved, adjust, adjustments,
    earned: 0, available: 0, accruing: 0, periods: [], alerts: [],
    upcoming: approved.filter(r => r.end_day && r.end_day >= today),
  };
  if (!emp.hire_date) {
    out.available = adjust - used - sold;
    out.alerts.push('Informe a data de admissão para calcular as férias');
    return out;
  }

  // Períodos aquisitivos completos até hoje.
  let n = 0;
  while (addYears(emp.hire_date, n + 1) <= today) n++;
  out.earned = n * DAYS_PER_PERIOD + adjust;
  out.available = out.earned - used - sold;

  // Período aquisitivo em andamento: 2,5 dias por mês trabalhado.
  const curStart = addYears(emp.hire_date, n);
  const months = Math.floor(daysBetween(curStart, today) / 30.4375);
  out.accruing = Math.min(DAYS_PER_PERIOD, Math.floor(months * 2.5));
  out.currentPeriod = { start: curStart, end: addDays(addYears(emp.hire_date, n + 1), -1) };

  // Os dias usados e vendidos quitam primeiro o período mais antigo.
  let consumed = used + sold - adjust;
  for (let i = 0; i < n; i++) {
    const take = Math.max(0, Math.min(DAYS_PER_PERIOD, consumed));
    consumed -= take;
    const p = {
      start: addYears(emp.hire_date, i),
      end: addDays(addYears(emp.hire_date, i + 1), -1),
      deadline: addDays(addYears(emp.hire_date, i + 2), -1), // fim do período concessivo
      balance: DAYS_PER_PERIOD - take,
    };
    out.periods.push(p);
  }
  const open = out.periods.filter(p => p.balance > 0);
  if (open.length) {
    out.nextDeadline = open[0].deadline;
    for (const p of open) {
      const left = daysBetween(today, p.deadline);
      if (left < 0) out.alerts.push(`Férias vencidas: ${p.balance} dias do período ${br(p.start)} a ${br(p.end)} (devem ser pagas em dobro)`);
      else if (left <= 90) out.alerts.push(`${p.balance} dias de férias vencem em ${br(p.deadline)}`);
    }
  }
  return out;
}

function br(day) { return day.split('-').reverse().join('/'); }

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Valida um pedido de férias e devolve os dias calculados. */
async function validateRequest(emp, b, { isAdmin }) {
  const sell = Number(b.sell_days || 0);
  const hasPeriod = !!(b.start_day || b.end_day);
  if (!Number.isInteger(sell) || sell < 0) throw err('Quantidade de dias para vender inválida');
  if (!hasPeriod && !sell) throw err('Informe o período de férias ou quantos dias quer vender');
  if (sell > MAX_SELL) throw err(`É possível vender no máximo ${MAX_SELL} dias (1/3 das férias)`);

  let days = 0;
  if (hasPeriod) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_day || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.end_day || '')) throw err('Informe o início e o fim das férias');
    if (b.end_day < b.start_day) throw err('O fim das férias é antes do início');
    days = eachDay(b.start_day, b.end_day).length;
    if (days < MIN_PERIOD_DAYS) throw err(`Cada período de férias precisa ter pelo menos ${MIN_PERIOD_DAYS} dias`);
    if (days > DAYS_PER_PERIOD) throw err(`Um período de férias pode ter no máximo ${DAYS_PER_PERIOD} dias`);
    if (!isAdmin && b.start_day <= localDay(new Date())) throw err('As férias precisam começar depois de hoje');
    const clash = await db.get(
      `SELECT id FROM vacation_requests WHERE employee_id = ? AND status IN ('aprovado', 'pendente')
       AND start_day IS NOT NULL AND start_day <= ? AND end_day >= ?`, [emp.id, b.end_day, b.start_day]);
    if (clash) throw err('Já existe férias marcadas ou pedidas nesse período');
  }

  const sum = await vacationSummary(emp);
  const free = sum.available - sum.reserved;
  if (days + sell > free) {
    throw err(`Saldo insuficiente: ${Math.max(0, free)} dia(s) disponíveis${sum.reserved ? ` (${sum.reserved} já estão em pedidos aguardando aprovação)` : ''}`);
  }
  return { days, sell };
}

module.exports = { vacationSummary, validateRequest, MAX_SELL, MIN_PERIOD_DAYS };
