process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, init, getSettings, DEFAULT_SETTINGS } = require('./db');
const { computeReport, localDay, localIso, hhmm, timeOf } = require('./rules');
const { notify, sendEmail, emailConfigured } = require('./mailer');
const { vacationSummary, validateRequest } = require('./vacations');
const { buildPdf, buildXlsx, buildOccurrencesPdf, buildOccurrencesXlsx } = require('./export');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const SESSION_DAYS = 30;

// Usado por serviços de monitoramento para manter o app acordado em hospedagens gratuitas.
app.get('/health', (req, res) => res.send('ok'));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- autenticação ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function auth(req, res, next) {
  const token = parseCookies(req).sid;
  const row = token && await db.get(
    `SELECT e.* FROM sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token = ? AND s.expires_at > ? AND e.active = 1`, [token, Date.now()]);
  if (!row) return res.status(401).json({ error: 'Faça login novamente' });
  req.user = row;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  next();
}

function publicUser(u) {
  return { id: u.id, name: u.name, login: u.login, role: u.role, work_days: u.work_days,
    start_time: u.start_time, end_time: u.end_time, break_minutes: u.break_minutes,
    sat_start: u.sat_start, sat_end: u.sat_end, hire_date: u.hire_date || null, active: !!u.active };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const br = day => day.split('-').reverse().join('/');

// Nome da marcação pela ordem no dia: entrada, saída para intervalo, volta, saída.
function punchLabel(index) {
  const labels = ['Entrada', 'Saída para intervalo', 'Volta do intervalo', 'Saída'];
  return labels[index] || (index % 2 ? 'Saída' : 'Entrada');
}

const loginAttempts = new Map();
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  const key = `${req.ip}|${login}`;
  const a = loginAttempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  const u = await db.get('SELECT * FROM employees WHERE login = ? AND active = 1', [String(login || '').trim().toLowerCase()]);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    loginAttempts.set(key, a);
    return res.status(401).json({ error: 'Login ou senha inválidos' });
  }
  loginAttempts.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, employee_id, expires_at) VALUES (?, ?, ?)',
    [token, u.id, Date.now() + SESSION_DAYS * 86400000]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json(publicUser(u));
});

app.post('/api/logout', auth, async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token = ?', [parseCookies(req).sid]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/me/password', auth, async (req, res) => {
  const { current, next: newPass } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
  if (!newPass || String(newPass).length < 6) return res.status(400).json({ error: 'A nova senha precisa de pelo menos 6 caracteres' });
  await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(String(newPass), 10), req.user.id]);
  res.json({ ok: true });
});

// ---------- registro de ponto ----------
app.post('/api/punch', auth, async (req, res) => {
  const now = new Date();
  const last = await db.get('SELECT ts FROM punches WHERE employee_id = ? AND deleted = 0 ORDER BY ts DESC LIMIT 1', [req.user.id]);
  if (last && now - new Date(last.ts) < 60000) {
    return res.status(409).json({ error: 'Ponto já registrado há menos de 1 minuto' });
  }
  const ua = String(req.headers['user-agent'] || '').slice(0, 250);
  const source = /Mobi|Android|iPhone/i.test(ua) ? 'celular' : 'computador';
  const ts = localIso(now);
  const r = await db.get('INSERT INTO punches (employee_id, ts, day, source, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [req.user.id, ts, localDay(now), source, req.ip, ua]);
  res.json({ id: Number(r.id), ts });

  // Aviso por e-mail aos administradores (em segundo plano).
  try {
    const today = (await computeReport(req.user.id, localDay(now), localDay(now))).days[0];
    const idx = today.punches.findIndex(p => Number(p.id) === Number(r.id));
    const label = punchLabel(idx);
    const lines = [`${req.user.name} registrou: ${label}`, `Horário: ${timeOf(ts)} de ${br(localDay(now))} (pelo ${source})`];
    if (idx === 0 && today.late) lines.push(`Atraso de ${hhmm(today.late)} (entrada prevista ${today.scheduleStart})`);
    if (today.early && idx === today.punches.length - 1) lines.push(`Saída antecipada de ${hhmm(today.early)} (saída prevista ${today.scheduleEnd})`);
    notify(`Ponto: ${req.user.name} · ${label} às ${timeOf(ts)}`, lines);
  } catch (e) { console.error('Falha ao preparar aviso de ponto:', e.message); }
});

function period(req) {
  const today = localDay(new Date());
  const from = DAY_RE.test(req.query.from || '') ? req.query.from : today.slice(0, 8) + '01';
  const to = DAY_RE.test(req.query.to || '') ? req.query.to : today;
  if (from > to) throw Object.assign(new Error('Período inválido'), { status: 400 });
  return { from, to };
}

app.get('/api/my/report', auth, async (req, res) => {
  const { from, to } = period(req);
  res.json(await computeReport(req.user.id, from, to));
});

// ---------- relatórios (admin: qualquer funcionário; funcionário: só o próprio) ----------
async function reportsFor(req) {
  const { from, to } = period(req);
  let ids;
  if (req.user.role !== 'admin') ids = [req.user.id];
  else if (req.query.employee && req.query.employee !== 'all') ids = [Number(req.query.employee)];
  else ids = (await db.all("SELECT id FROM employees WHERE active = 1 AND role = 'employee' ORDER BY name")).map(r => r.id);
  const reports = [];
  for (const id of ids) reports.push(await computeReport(id, from, to));
  return { from, to, reports };
}

function fileName(req, from, to, ext) {
  const who = req.user.role !== 'admin' ? req.user.login
    : (req.query.employee && req.query.employee !== 'all' ? `func${req.query.employee}` : 'todos');
  return `ponto_${who}_${from}_${to}.${ext}`;
}

app.get('/api/report', auth, async (req, res) => res.json((await reportsFor(req)).reports));

app.get('/api/report.pdf', auth, async (req, res) => {
  const { from, to, reports } = await reportsFor(req);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, from, to, 'pdf')}"`);
  buildPdf(reports, res);
});

app.get('/api/report.xlsx', auth, async (req, res) => {
  const { from, to, reports } = await reportsFor(req);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, from, to, 'xlsx')}"`);
  await buildXlsx(reports, res);
});

// ---------- administração: funcionários ----------
app.get('/api/employees', auth, adminOnly, async (req, res) => {
  res.json((await db.all('SELECT * FROM employees ORDER BY active DESC, name')).map(publicUser));
});

function validateEmployee(b, isNew) {
  if (isNew && (!b.name || !b.login || !b.password)) return 'Nome, login e senha são obrigatórios';
  for (const k of ['start_time', 'end_time', 'sat_start', 'sat_end']) {
    if (b[k] !== undefined && !TIME_RE.test(b[k])) return 'Horário inválido';
  }
  if (b.password && String(b.password).length < 6) return 'A senha precisa de pelo menos 6 caracteres';
  if (b.work_days && !/^[0-6](,[0-6])*$/.test(b.work_days)) return 'Dias de trabalho inválidos';
  if (b.hire_date && !DAY_RE.test(b.hire_date)) return 'Data de admissão inválida';
  return null;
}

app.post('/api/employees', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const err = validateEmployee(b, true);
  if (err) return res.status(400).json({ error: err });
  const active = Number((await db.get('SELECT COUNT(*) AS n FROM employees WHERE active = 1')).n);
  if (active >= Number(process.env.MAX_USERS || 11)) return res.status(400).json({ error: 'Limite de usuários atingido' });
  try {
    const u = await db.get(
      `INSERT INTO employees (name, login, password_hash, role, work_days, start_time, end_time, break_minutes, sat_start, sat_end, hire_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [String(b.name).trim(), String(b.login).trim().toLowerCase(), bcrypt.hashSync(String(b.password), 10),
        b.role === 'admin' ? 'admin' : 'employee', b.work_days || '1,2,3,4,5',
        b.start_time || '08:00', b.end_time || '17:00', Number(b.break_minutes ?? 60), b.sat_start || '08:00', b.sat_end || '12:00', b.hire_date || null]);
    res.json(publicUser(u));
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(e.message)) return res.status(400).json({ error: 'Esse login já existe' });
    throw e;
  }
});

app.put('/api/employees/:id', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT * FROM employees WHERE id = ?', [id]);
  if (!u) return res.status(404).json({ error: 'Funcionário não encontrado' });
  const b = req.body || {};
  const err = validateEmployee(b, false);
  if (err) return res.status(400).json({ error: err });
  if (id === req.user.id && (b.active === false || b.role === 'employee')) {
    return res.status(400).json({ error: 'Você não pode desativar ou rebaixar a própria conta' });
  }
  await db.run(`UPDATE employees SET name = ?, role = ?, work_days = ?, start_time = ?, end_time = ?, break_minutes = ?,
      sat_start = ?, sat_end = ?, hire_date = ?, active = ? WHERE id = ?`,
    [b.name ?? u.name, b.role ?? u.role, b.work_days ?? u.work_days, b.start_time ?? u.start_time, b.end_time ?? u.end_time,
      Number(b.break_minutes ?? u.break_minutes), b.sat_start ?? u.sat_start, b.sat_end ?? u.sat_end,
      b.hire_date === undefined ? u.hire_date : (b.hire_date || null),
      b.active === undefined ? u.active : (b.active ? 1 : 0), id]);
  if (b.password) await db.run('UPDATE employees SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(String(b.password), 10), id]);
  if (b.active === false) await db.run('DELETE FROM sessions WHERE employee_id = ?', [id]);
  res.json(publicUser(await db.get('SELECT * FROM employees WHERE id = ?', [id])));
});

// ---------- administração: ajuste de marcações (com justificativa e auditoria) ----------
function audit(req, action, punchId, employeeId, details, reason) {
  return db.run('INSERT INTO audit_log (admin_id, action, punch_id, employee_id, details, reason) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, action, punchId, employeeId, details, reason]);
}

function parseLocal(day, time) {
  if (!DAY_RE.test(day || '') || !/^\d{2}:\d{2}$/.test(time || '')) return null;
  const d = new Date(`${day}T${time}:00`);
  return isNaN(d) ? null : d;
}

// Ajustes de marcação usados pelo admin e pela aprovação de pedidos de correção.
async function addPunch(req, employeeId, day, time, reason) {
  const d = parseLocal(day, time);
  if (!d) throw Object.assign(new Error('Data ou hora inválida'), { status: 400 });
  const emp = await db.get('SELECT id FROM employees WHERE id = ?', [Number(employeeId)]);
  if (!emp) throw Object.assign(new Error('Funcionário não encontrado'), { status: 404 });
  const r = await db.get("INSERT INTO punches (employee_id, ts, day, source) VALUES (?, ?, ?, 'ajuste') RETURNING id",
    [emp.id, localIso(d), localDay(d)]);
  await audit(req, 'incluir', Number(r.id), emp.id, `${day} ${time}`, reason);
}

async function changePunch(req, p, time, reason) {
  const d = parseLocal(p.day, time);
  if (!d) throw Object.assign(new Error('Hora inválida'), { status: 400 });
  await db.run("UPDATE punches SET ts = ?, source = 'ajuste' WHERE id = ?", [localIso(d), p.id]);
  await audit(req, 'alterar', p.id, p.employee_id, `${p.ts} → ${localIso(d)}`, reason);
}

async function deletePunch(req, p, reason) {
  await db.run('UPDATE punches SET deleted = 1 WHERE id = ?', [p.id]);
  await audit(req, 'excluir', p.id, p.employee_id, p.ts, reason);
}

const needReason = reason => { if (!reason) throw Object.assign(new Error('Informe a justificativa'), { status: 400 }); };
const findPunch = async id => {
  const p = await db.get('SELECT * FROM punches WHERE id = ? AND deleted = 0', [Number(id)]);
  if (!p) throw Object.assign(new Error('Marcação não encontrada'), { status: 404 });
  return p;
};

app.post('/api/punches', auth, adminOnly, async (req, res) => {
  const { employee_id, day, time, reason } = req.body || {};
  needReason(reason);
  await addPunch(req, employee_id, day, time, reason);
  res.json({ ok: true });
});

app.put('/api/punches/:id', auth, adminOnly, async (req, res) => {
  const p = await findPunch(req.params.id);
  needReason(req.body?.reason);
  await changePunch(req, p, req.body?.time, req.body.reason);
  res.json({ ok: true });
});

app.delete('/api/punches/:id', auth, adminOnly, async (req, res) => {
  const p = await findPunch(req.params.id);
  needReason(req.body?.reason);
  await deletePunch(req, p, req.body.reason);
  res.json({ ok: true });
});

// ---------- pedidos de correção (funcionário pede, admin aprova) ----------
app.post('/api/corrections', auth, async (req, res) => {
  const { day, action, punch_id, time, reason } = req.body || {};
  if (!DAY_RE.test(day || '')) return res.status(400).json({ error: 'Data inválida' });
  if (!['incluir', 'alterar', 'excluir'].includes(action)) return res.status(400).json({ error: 'Tipo de correção inválido' });
  if (!reason) return res.status(400).json({ error: 'Explique o motivo da correção' });
  if (action !== 'excluir' && !TIME_RE.test(time || '')) return res.status(400).json({ error: 'Informe o horário correto' });
  if (action !== 'incluir') {
    const p = await db.get('SELECT * FROM punches WHERE id = ? AND employee_id = ? AND deleted = 0', [Number(punch_id), req.user.id]);
    if (!p || p.day !== day) return res.status(400).json({ error: 'Escolha a marcação a corrigir' });
  }
  const dup = await db.get("SELECT id FROM correction_requests WHERE employee_id = ? AND day = ? AND status = 'pendente' AND action = ? AND COALESCE(punch_id, 0) = ? AND COALESCE(time, '') = ?",
    [req.user.id, day, action, action === 'incluir' ? 0 : Number(punch_id), action === 'excluir' ? '' : time]);
  if (dup) return res.status(409).json({ error: 'Já existe um pedido igual aguardando aprovação' });
  await db.run('INSERT INTO correction_requests (employee_id, day, action, punch_id, time, reason) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, day, action, action === 'incluir' ? null : Number(punch_id), action === 'excluir' ? null : time, String(reason)]);
  notify(`Ponto: ${req.user.name} pediu correção do dia ${br(day)}`,
    [`${req.user.name} pediu para ${action} uma marcação em ${br(day)}${time && action !== 'excluir' ? ` (horário ${time})` : ''}.`,
      `Motivo: ${reason}`, 'Aprove ou recuse na aba Solicitações do app.']);
  res.json({ ok: true });
});

app.get('/api/corrections', auth, async (req, res) => {
  const admin = req.user.role === 'admin';
  const where = [], params = [];
  if (!admin) { where.push('c.employee_id = ?'); params.push(req.user.id); }
  if (req.query.status) { where.push('c.status = ?'); params.push(String(req.query.status)); }
  const rows = await db.all(
    `SELECT c.*, e.name AS employee_name, r.name AS reviewer_name, p.ts AS punch_ts FROM correction_requests c
     JOIN employees e ON e.id = c.employee_id LEFT JOIN employees r ON r.id = c.reviewed_by
     LEFT JOIN punches p ON p.id = c.punch_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT 200`, params);
  res.json(rows.map(r => ({ ...r, punch_time: r.punch_ts ? timeOf(r.punch_ts) : null })));
});

app.delete('/api/corrections/:id', auth, async (req, res) => {
  await db.run("DELETE FROM correction_requests WHERE id = ? AND employee_id = ? AND status = 'pendente'", [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

async function reviewCorrection(req, approve) {
  const c = await db.get("SELECT * FROM correction_requests WHERE id = ? AND status = 'pendente'", [Number(req.params.id)]);
  if (!c) throw Object.assign(new Error('Pedido não encontrado ou já analisado'), { status: 404 });
  if (approve) {
    const reason = `Pedido de correção nº ${c.id} aprovado: ${c.reason}`;
    if (c.action === 'incluir') await addPunch(req, c.employee_id, c.day, c.time, reason);
    else {
      const p = await findPunch(c.punch_id);
      if (c.action === 'alterar') await changePunch(req, p, c.time, reason);
      else await deletePunch(req, p, reason);
    }
  }
  await db.run('UPDATE correction_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?',
    [approve ? 'aprovado' : 'recusado', req.user.id, req.body?.note || null, localIso(new Date()), c.id]);
}

app.post('/api/corrections/:id/approve', auth, adminOnly, async (req, res) => { await reviewCorrection(req, true); res.json({ ok: true }); });
app.post('/api/corrections/:id/reject', auth, adminOnly, async (req, res) => { await reviewCorrection(req, false); res.json({ ok: true }); });

// ---------- férias (saldo, pedidos com venda de dias e aprovação do admin) ----------
app.get('/api/vacations/summary', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json([await vacationSummary(req.user)]);
  const emps = await db.all("SELECT * FROM employees WHERE active = 1 AND role = 'employee' ORDER BY name");
  const out = [];
  for (const e of emps) out.push(await vacationSummary(e));
  res.json(out);
});

app.get('/api/vacations/requests', auth, async (req, res) => {
  const admin = req.user.role === 'admin';
  const where = [], params = [];
  if (!admin) { where.push('v.employee_id = ?'); params.push(req.user.id); }
  else if (req.query.employee_id) { where.push('v.employee_id = ?'); params.push(Number(req.query.employee_id)); }
  if (req.query.status) { where.push('v.status = ?'); params.push(String(req.query.status)); }
  res.json(await db.all(
    `SELECT v.*, e.name AS employee_name, r.name AS reviewer_name FROM vacation_requests v
     JOIN employees e ON e.id = v.employee_id LEFT JOIN employees r ON r.id = v.reviewed_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.id DESC LIMIT 200`, params));
});

function vacationText(v) {
  const parts = [];
  if (v.days) parts.push(`${v.days} dias de descanso, de ${br(v.start_day)} a ${br(v.end_day)}`);
  if (v.sell_days) parts.push(`venda de ${v.sell_days} dias`);
  return parts.join(' e ');
}

// Funcionário pede para si (fica pendente); admin pode lançar férias de alguém já aprovadas.
app.post('/api/vacations/requests', auth, async (req, res) => {
  const b = req.body || {};
  const admin = req.user.role === 'admin' && b.employee_id;
  const emp = admin ? await db.get('SELECT * FROM employees WHERE id = ?', [Number(b.employee_id)]) : req.user;
  if (!emp) return res.status(404).json({ error: 'Funcionário não encontrado' });
  const { days, sell } = await validateRequest(emp, b, { isAdmin: !!admin });
  const v = await db.get(
    `INSERT INTO vacation_requests (employee_id, start_day, end_day, days, sell_days, note, status, created_by, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [emp.id, days ? b.start_day : null, days ? b.end_day : null, days, sell, b.note ? String(b.note) : null,
      admin ? 'aprovado' : 'pendente', req.user.id, admin ? req.user.id : null, admin ? localIso(new Date()) : null]);
  if (!admin) {
    notify(`Férias: ${emp.name} enviou um pedido para aprovação`,
      [`${emp.name} pediu ${vacationText(v)}.`, ...(v.note ? [`Observação: ${v.note}`] : []),
        'Aprove ou recuse na aba Férias do app.']);
  }
  res.json(v);
});

async function reviewVacation(req, approve) {
  const v = await db.get("SELECT * FROM vacation_requests WHERE id = ? AND status = 'pendente'", [Number(req.params.id)]);
  if (!v) throw Object.assign(new Error('Pedido não encontrado ou já analisado'), { status: 404 });
  await db.run('UPDATE vacation_requests SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ? WHERE id = ?',
    [approve ? 'aprovado' : 'recusado', req.user.id, req.body?.note || null, localIso(new Date()), v.id]);
}

app.post('/api/vacations/requests/:id/approve', auth, adminOnly, async (req, res) => { await reviewVacation(req, true); res.json({ ok: true }); });
app.post('/api/vacations/requests/:id/reject', auth, adminOnly, async (req, res) => { await reviewVacation(req, false); res.json({ ok: true }); });

// Funcionário cancela o próprio pedido pendente; admin cancela qualquer pedido (o saldo volta).
app.delete('/api/vacations/requests/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.role === 'admin') {
    await db.run("UPDATE vacation_requests SET status = 'cancelado', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status IN ('pendente', 'aprovado')",
      [req.user.id, localIso(new Date()), id]);
  } else {
    await db.run("DELETE FROM vacation_requests WHERE id = ? AND employee_id = ? AND status = 'pendente'", [id, req.user.id]);
  }
  res.json({ ok: true });
});

// Ajuste manual de saldo (ex.: férias tiradas antes de usar o app, dias de saldo combinados).
app.post('/api/vacations/adjustments', auth, adminOnly, async (req, res) => {
  const { employee_id, days, reason } = req.body || {};
  const n = Number(days);
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 120) return res.status(400).json({ error: 'Informe os dias (positivo soma, negativo desconta)' });
  if (!reason) return res.status(400).json({ error: 'Explique o motivo do ajuste' });
  if (!await db.get('SELECT id FROM employees WHERE id = ?', [Number(employee_id)])) return res.status(404).json({ error: 'Funcionário não encontrado' });
  await db.run('INSERT INTO vacation_adjustments (employee_id, days, reason, created_by) VALUES (?, ?, ?, ?)',
    [Number(employee_id), n, String(reason), req.user.id]);
  res.json({ ok: true });
});

// ---------- jornadas especiais (entrada/saída diferente da padrão em dias específicos) ----------
app.get('/api/exceptions', auth, adminOnly, async (req, res) => {
  const { from, to } = period(req);
  res.json(await db.all(
    `SELECT x.*, e.name AS employee_name FROM schedule_exceptions x LEFT JOIN employees e ON e.id = x.employee_id
     WHERE x.day BETWEEN ? AND ? ORDER BY x.day, e.name`, [from, to]));
});

app.post('/api/exceptions', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!DAY_RE.test(b.day || '')) return res.status(400).json({ error: 'Data inválida' });
  const until = DAY_RE.test(b.until || '') ? b.until : b.day;
  if (until < b.day) return res.status(400).json({ error: 'A data final é anterior à inicial' });
  const dayOff = b.day_off ? 1 : 0;
  if (!dayOff && (!TIME_RE.test(b.start_time || '') || !TIME_RE.test(b.end_time || ''))) {
    return res.status(400).json({ error: 'Informe os horários de entrada e saída' });
  }
  const empId = b.employee_id && b.employee_id !== 'all' ? Number(b.employee_id) : null;
  const { eachDay } = require('./rules');
  const days = eachDay(b.day, until);
  if (days.length > 62) return res.status(400).json({ error: 'Cadastre no máximo 62 dias por vez' });
  for (const day of days) {
    // Substitui jornada especial que já existia para o mesmo dia e funcionário.
    await db.run(`DELETE FROM schedule_exceptions WHERE day = ? AND ${empId ? 'employee_id = ?' : 'employee_id IS NULL'}`,
      empId ? [day, empId] : [day]);
    await db.run('INSERT INTO schedule_exceptions (employee_id, day, start_time, end_time, break_minutes, day_off, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [empId, day, dayOff ? null : b.start_time, dayOff ? null : b.end_time, dayOff ? 0 : Number(b.break_minutes || 0), dayOff, b.reason || null]);
  }
  res.json({ ok: true, days: days.length });
});

app.delete('/api/exceptions/:id', auth, adminOnly, async (req, res) => {
  await db.run('DELETE FROM schedule_exceptions WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- ocorrências e justificativas ----------
app.post('/api/day-notes', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!DAY_RE.test(b.day || '') || !b.kind) return res.status(400).json({ error: 'Informe o dia e o tipo' });
  await db.run('INSERT INTO day_notes (employee_id, day, kind, note, excused, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(b.employee_id), b.day, String(b.kind), b.note || null, b.excused ? 1 : 0, req.user.id]);
  res.json({ ok: true });
});

app.delete('/api/day-notes/:id', auth, adminOnly, async (req, res) => {
  await db.run('DELETE FROM day_notes WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

async function occurrencesFor(req) {
  const { from, to, reports } = await reportsFor(req);
  const rows = [];
  for (const r of reports) {
    for (const d of r.days) {
      if (d.alerts.length || d.notes.length || (d.special && !d.vacation)) rows.push({ employee: r.employee, ...d });
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.employee.name.localeCompare(b.employee.name));
  return { from, to, rows, company: (await getSettings()).company_name };
}

app.get('/api/occurrences', auth, async (req, res) => res.json((await occurrencesFor(req)).rows));

app.get('/api/occurrences.pdf', auth, async (req, res) => {
  const o = await occurrencesFor(req);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, o.from, o.to, 'pdf').replace('ponto_', 'ocorrencias_')}"`);
  buildOccurrencesPdf(o, res);
});

app.get('/api/occurrences.xlsx', auth, async (req, res) => {
  const o = await occurrencesFor(req);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(req, o.from, o.to, 'xlsx').replace('ponto_', 'ocorrencias_')}"`);
  await buildOccurrencesXlsx(o, res);
});

app.get('/api/audit', auth, adminOnly, async (req, res) => {
  res.json(await db.all(
    `SELECT a.*, adm.name AS admin_name, e.name AS employee_name FROM audit_log a
     LEFT JOIN employees adm ON adm.id = a.admin_id LEFT JOIN employees e ON e.id = a.employee_id
     ORDER BY a.id DESC LIMIT 200`));
});

// ---------- painel do dia ----------
app.get('/api/today', auth, adminOnly, async (req, res) => {
  const today = localDay(new Date());
  const emps = await db.all("SELECT id, name FROM employees WHERE active = 1 AND role = 'employee' ORDER BY name");
  const out = [];
  for (const e of emps) {
    const r = (await computeReport(e.id, today, today)).days[0];
    const n = r.punches.length;
    out.push({ id: e.id, name: e.name, punches: r.punches, worked: r.worked, alerts: r.alerts,
      status: n === 0 ? 'Não registrou' : n % 2 ? 'Trabalhando' : n >= 4 ? 'Encerrou' : 'Em intervalo ou encerrou' });
  }
  res.json(out);
});

// ---------- configurações e feriados ----------
app.get('/api/settings', auth, adminOnly, async (req, res) => {
  const st = await getSettings();
  res.json({ ...st, _email_key: !!process.env.BREVO_API_KEY, _email_ready: emailConfigured(st) });
});

app.post('/api/settings/test-email', auth, adminOnly, async (req, res) => {
  try {
    const r = await sendEmail('Teste de e-mail do ponto', [`E-mail de teste enviado por ${req.user.name}.`, 'Se você recebeu, os avisos de registro de ponto estão funcionando.']);
    if (!r.sent) return res.status(400).json({ error: r.reason });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.put('/api/settings', auth, adminOnly, async (req, res) => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[k] !== undefined) await db.run('UPDATE settings SET value = ? WHERE key = ?', [String(req.body[k]), k]);
  }
  res.json(await getSettings());
});

app.get('/api/holidays', auth, async (req, res) => res.json(await db.all('SELECT * FROM holidays ORDER BY day')));

app.post('/api/holidays', auth, adminOnly, async (req, res) => {
  const { day, name } = req.body || {};
  if (!DAY_RE.test(day || '') || !name) return res.status(400).json({ error: 'Data e nome são obrigatórios' });
  await db.run('INSERT INTO holidays (day, name) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET name = excluded.name', [day, name]);
  res.json({ ok: true });
});

app.delete('/api/holidays/:day', auth, adminOnly, async (req, res) => {
  await db.run('DELETE FROM holidays WHERE day = ?', [req.params.day]);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno' });
});

const PORT = Number(process.env.PORT) || 3000;
init().then(() => app.listen(PORT, () => console.log(`Ponto rodando em http://localhost:${PORT}`)))
  .catch(e => { console.error('Falha ao iniciar o banco de dados:', e); process.exit(1); });
