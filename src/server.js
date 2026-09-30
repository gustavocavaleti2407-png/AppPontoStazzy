process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, init, getSettings, DEFAULT_SETTINGS } = require('./db');
const { computeReport, localDay, localIso } = require('./rules');
const { buildPdf, buildXlsx } = require('./export');

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
  return { id: u.id, name: u.name, login: u.login, role: u.role, daily_minutes: u.daily_minutes,
    work_days: u.work_days, saturday_minutes: u.saturday_minutes, active: !!u.active };
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
  if (b.password && String(b.password).length < 6) return 'A senha precisa de pelo menos 6 caracteres';
  if (b.work_days && !/^[0-6](,[0-6])*$/.test(b.work_days)) return 'Dias de trabalho inválidos';
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
      'INSERT INTO employees (name, login, password_hash, role, daily_minutes, work_days, saturday_minutes) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      [String(b.name).trim(), String(b.login).trim().toLowerCase(), bcrypt.hashSync(String(b.password), 10),
        b.role === 'admin' ? 'admin' : 'employee', Number(b.daily_minutes) || 480,
        b.work_days || '1,2,3,4,5', Number(b.saturday_minutes) || 240]);
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
  await db.run(`UPDATE employees SET name = ?, role = ?, daily_minutes = ?, work_days = ?, saturday_minutes = ?, active = ? WHERE id = ?`,
    [b.name ?? u.name, b.role ?? u.role, Number(b.daily_minutes ?? u.daily_minutes), b.work_days ?? u.work_days,
      Number(b.saturday_minutes ?? u.saturday_minutes), b.active === undefined ? u.active : (b.active ? 1 : 0), id]);
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

app.post('/api/punches', auth, adminOnly, async (req, res) => {
  const { employee_id, day, time, reason } = req.body || {};
  const d = parseLocal(day, time);
  if (!d) return res.status(400).json({ error: 'Data ou hora inválida' });
  if (!reason) return res.status(400).json({ error: 'Informe a justificativa' });
  const emp = await db.get('SELECT id FROM employees WHERE id = ?', [Number(employee_id)]);
  if (!emp) return res.status(404).json({ error: 'Funcionário não encontrado' });
  const r = await db.get("INSERT INTO punches (employee_id, ts, day, source) VALUES (?, ?, ?, 'ajuste') RETURNING id",
    [emp.id, localIso(d), localDay(d)]);
  await audit(req, 'incluir', Number(r.id), Number(employee_id), `${day} ${time}`, reason);
  res.json({ ok: true });
});

app.put('/api/punches/:id', auth, adminOnly, async (req, res) => {
  const p = await db.get('SELECT * FROM punches WHERE id = ? AND deleted = 0', [Number(req.params.id)]);
  if (!p) return res.status(404).json({ error: 'Marcação não encontrada' });
  const { time, reason } = req.body || {};
  const d = parseLocal(p.day, time);
  if (!d) return res.status(400).json({ error: 'Hora inválida' });
  if (!reason) return res.status(400).json({ error: 'Informe a justificativa' });
  await db.run("UPDATE punches SET ts = ?, source = 'ajuste' WHERE id = ?", [localIso(d), p.id]);
  await audit(req, 'alterar', p.id, p.employee_id, `${p.ts} → ${localIso(d)}`, reason);
  res.json({ ok: true });
});

app.delete('/api/punches/:id', auth, adminOnly, async (req, res) => {
  const p = await db.get('SELECT * FROM punches WHERE id = ? AND deleted = 0', [Number(req.params.id)]);
  if (!p) return res.status(404).json({ error: 'Marcação não encontrada' });
  const reason = req.body?.reason;
  if (!reason) return res.status(400).json({ error: 'Informe a justificativa' });
  await db.run('UPDATE punches SET deleted = 1 WHERE id = ?', [p.id]);
  await audit(req, 'excluir', p.id, p.employee_id, p.ts, reason);
  res.json({ ok: true });
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
app.get('/api/settings', auth, adminOnly, async (req, res) => res.json(await getSettings()));

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
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno' });
});

const PORT = Number(process.env.PORT) || 3000;
init().then(() => app.listen(PORT, () => console.log(`Ponto rodando em http://localhost:${PORT}`)))
  .catch(e => { console.error('Falha ao iniciar o banco de dados:', e); process.exit(1); });
