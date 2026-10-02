const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const hhmm = m => { const s = m < 0 ? '-' : ''; m = Math.abs(Math.round(m)); return `${s}${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const t = m => (m ? hhmm(m) : '');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const br = d => d.split('-').reverse().join('/');
const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

let me = null;
let employees = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Erro');
  return data;
}

// ---------- login ----------
function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    me = await api('/api/login', { method: 'POST', body: { login: f.get('login'), password: f.get('password') } });
    e.target.reset();
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

// ---------- navegação ----------
function tabsFor(role) {
  return role === 'admin'
    ? [['painel', 'Painel'], ['espelho', 'Relatórios'], ['ocorrencias', 'Ocorrências'], ['solicitacoes', 'Solicitações'],
      ['ferias', 'Férias'], ['jornadas', 'Jornadas especiais'], ['funcionarios', 'Funcionários'], ['config', 'Configurações'], ['conta', 'Conta']]
    : [['ponto', 'Bater ponto'], ['espelho', 'Meu espelho'], ['ocorrencias', 'Ocorrências'], ['solicitacoes', 'Correções'], ['ferias', 'Férias'], ['conta', 'Conta']];
}

function openTab(name) {
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hidden', s.dataset.tab !== name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ({ ponto: loadToday, espelho: loadReport, painel: loadPanel, funcionarios: loadEmployees, config: loadConfig,
    ocorrencias: loadOccurrences, solicitacoes: loadCorrections, jornadas: loadExceptions, ferias: loadVacations }[name] || (() => {}))();
}

function refreshEmpFilter() {
  const opts = employees.filter(e => e.role === 'employee' && e.active).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('#emp-filter').innerHTML = '<option value="all">Todos</option>' + opts;
  $('#occ-emp').innerHTML = '<option value="all">Todos</option>' + opts;
  $('#exc-emp').innerHTML = '<option value="all">Todos os funcionários</option>' + opts;
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function refreshPendingBadge() {
  if (me.role !== 'admin') return;
  const [pend, vac] = await Promise.all([api('/api/corrections?status=pendente').catch(() => []),
    api('/api/vacations/requests?status=pendente').catch(() => [])]);
  const b = document.querySelector('#tabs button[data-tab="solicitacoes"]');
  if (b) b.textContent = pend.length ? `Solicitações (${pend.length})` : 'Solicitações';
  const v = document.querySelector('#tabs button[data-tab="ferias"]');
  if (v) v.textContent = vac.length ? `Férias (${vac.length})` : 'Férias';
}

async function start() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#who').textContent = me.name;
  const tabs = tabsFor(me.role);
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
  document.body.classList.toggle('role-admin', me.role === 'admin');
  document.body.classList.toggle('role-employee', me.role !== 'admin');
  $('#from').value = $('#occ-from').value = today().slice(0, 8) + '01';
  $('#to').value = $('#occ-to').value = today();
  $('#exc-from').value = today().slice(0, 8) + '01';
  $('#exc-to').value = addDays(today(), 60);
  if (me.role === 'admin') {
    employees = await api('/api/employees');
    $('#emp-filter-wrap').classList.remove('hidden');
    refreshEmpFilter();
    refreshPendingBadge();
  }
  openTab(tabs[0][0]);
}

// ---------- bater ponto ----------
function tick() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('#date').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}
tick();
setInterval(tick, 1000);

function stat(label, value) { return `<div class="stat"><b>${value}</b><span>${label}</span></div>`; }

async function loadToday() {
  const r = await api(`/api/my/report?from=${today()}&to=${today()}`);
  const d = r.days[0];
  const labels = ['Entrada', 'Saída intervalo', 'Volta intervalo', 'Saída'];
  $('#today-punches').innerHTML = d.punches.length
    ? d.punches.map((p, i) => `<span class="chip">${labels[i] || (i % 2 ? 'Saída' : 'Entrada')}: ${p.time}</span>`).join('')
    : '<span class="muted">Nenhuma marcação hoje.</span>';
  const sched = d.scheduleStart ? `Jornada de hoje: ${d.scheduleStart} às ${d.scheduleEnd}` : 'Hoje não há jornada prevista';
  $('#today-schedule').textContent = sched + (d.special ? ` (${d.special})` : '');
  $('#today-summary').innerHTML = stat('Trabalhado', hhmm(d.worked)) + stat('Previsto', hhmm(d.expected)) +
    stat('Intervalo', hhmm(d.breakTotal)) + stat('Hora extra', hhmm(d.overtime50 + d.overtime100)) +
    (d.late ? stat('Atraso', hhmm(d.late)) : '');
  $('#today-alerts').innerHTML = d.alerts.map(a => `<li>${esc(a)}</li>`).join('');
  const next = labels[d.punches.length] || (d.punches.length % 2 ? 'Saída' : 'Entrada');
  $('#punch-btn').textContent = `Registrar ${next.toLowerCase()}`;
  $('#punch-btn').dataset.next = d.punches.length % 4;
}

$('#punch-btn').addEventListener('click', async e => {
  e.target.disabled = true;
  try {
    const r = await api('/api/punch', { method: 'POST' });
    const d = new Date(r.ts);
    $('#punch-msg').textContent = `Ponto registrado às ${pad(d.getHours())}:${pad(d.getMinutes())}.`;
    if (navigator.vibrate) navigator.vibrate(80);
    await loadToday();
  } catch (err) { $('#punch-msg').textContent = err.message; }
  e.target.disabled = false;
});

// ---------- espelho / relatórios ----------
function reportQuery() {
  const q = new URLSearchParams({ from: $('#from').value, to: $('#to').value });
  if (me.role === 'admin') q.set('employee', $('#emp-filter').value);
  return q.toString();
}

async function loadReport() {
  const reports = await api(`/api/report?${reportQuery()}`);
  const admin = me.role === 'admin';
  $('#report').innerHTML = reports.map(r => {
    const T = r.totals;
    const rows = r.days.map(d => {
      const cls = d.alerts.length ? 'alert' : (d.expected === 0 ? 'off' : '');
      const punches = d.punches.map(p =>
        admin ? `<span class="punch-edit" data-id="${p.id}" data-day="${d.day}" data-time="${p.time}" data-emp="${r.employee.id}" title="${esc(p.source)}">${p.time}</span>`
              : `<span title="${esc(p.source)}">${p.time}</span> `).join('');
      const add = admin ? ` <button class="link add-punch" data-day="${d.day}" data-emp="${r.employee.id}">+</button>`
        : ` <button class="link fix-day" data-day="${d.day}">Corrigir</button>`;
      const notes = dayNotes(d);
      return `<tr class="${cls}"><td class="num">${br(d.day)}</td><td>${d.weekday}</td><td class="num">${punches}${add}</td>
        <td class="num">${t(d.expected)}</td><td class="num">${t(d.worked)}</td><td class="num">${t(d.breakTotal)}</td>
        <td class="num">${t(d.overtime50)}</td><td class="num">${t(d.overtime100)}</td><td class="num">${t(d.deficit)}</td>
        <td class="num">${t(d.late)}</td><td class="num">${t(d.night)}</td><td>${notes}</td></tr>`;
    }).join('');
    return `<h2>${esc(r.employee.name)}</h2>
      <div class="stats">${stat('Trabalhado', hhmm(T.worked))}${stat('Previsto', hhmm(T.expected))}
        ${stat(`HE ${r.rates.weekday}%`, hhmm(T.overtime50))}${stat(`HE ${r.rates.sunday}%`, hhmm(T.overtime100))}
        ${stat('Débito', hhmm(T.deficit))}${stat('Saldo', hhmm(T.balance))}${stat('Noturno', hhmm(T.night))}
        ${stat('Atrasos', `${hhmm(T.late)} (${T.lateDays} dia${T.lateDays === 1 ? '' : 's'})`)}${stat('Faltas', T.absences)}</div>
      <div class="table-wrap"><table><thead><tr><th>Data</th><th>Dia</th><th>Marcações</th><th>Previsto</th><th>Trab.</th>
        <th>Interv.</th><th>HE 50%</th><th>HE 100%</th><th>Débito</th><th>Atraso</th><th>Noturno</th><th>Ocorrências</th></tr></thead>
        <tbody>${rows}</tbody></table></div><br>`;
  }).join('') || '<p class="muted">Nenhum funcionário cadastrado.</p>';

  document.querySelectorAll('.punch-edit').forEach(el => el.addEventListener('click', () => editPunch(el.dataset)));
  document.querySelectorAll('.add-punch').forEach(el => el.addEventListener('click', () => addPunch(el.dataset)));
  const byDay = {};
  if (!admin && reports[0]) for (const d of reports[0].days) byDay[d.day] = d;
  document.querySelectorAll('.fix-day').forEach(el => el.addEventListener('click', () => correctionForm(byDay[el.dataset.day])));
}

function noteText(n) { return `${n.kind}${n.excused ? ' (abonado)' : ''}${n.note ? `: ${n.note}` : ''}`; }

function dayNotes(d) {
  return [
    d.holiday ? `Feriado: ${d.holiday}` : '',
    d.vacation ? 'Férias' : '',
    d.special && !d.vacation ? `Jornada especial: ${d.special}${d.scheduleStart ? ` (${d.scheduleStart}–${d.scheduleEnd})` : ''}` : '',
    ...d.alerts, ...(d.notes || []).map(noteText),
  ].filter(Boolean).map(esc).join('<br>');
}

$('#load-report').addEventListener('click', loadReport);
$('#pdf-btn').addEventListener('click', () => { location.href = `/api/report.pdf?${reportQuery()}`; });
$('#xlsx-btn').addEventListener('click', () => { location.href = `/api/report.xlsx?${reportQuery()}`; });

// ---------- diálogo genérico ----------
function dialog(html, onSubmit) {
  const dlg = $('#dialog'), form = $('#dialog-form');
  form.innerHTML = html + `<p class="error" id="dlg-error"></p>`;
  form.onsubmit = async e => {
    const btn = e.submitter;
    if (!btn || btn.value === 'cancel') return;
    e.preventDefault();
    try { await onSubmit(new FormData(form), btn.value); dlg.close(); }
    catch (err) { $('#dlg-error').textContent = err.message; }
  };
  dlg.showModal();
}

function editPunch({ id, day, time }) {
  dialog(`<h2>Ajustar marcação de ${br(day)}</h2>
    <label>Horário<input type="time" name="time" value="${time}" required></label>
    <label>Justificativa<input name="reason" required placeholder="Ex.: esqueceu de registrar"></label>
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button>
      <button value="delete" class="danger">Excluir</button><button value="save" class="primary">Salvar</button></div>`,
  async (f, action) => {
    if (action === 'delete') await api(`/api/punches/${id}`, { method: 'DELETE', body: { reason: f.get('reason') } });
    else await api(`/api/punches/${id}`, { method: 'PUT', body: { time: f.get('time'), reason: f.get('reason') } });
    loadReport();
  });
}

function addPunch({ day, emp }) {
  dialog(`<h2>Incluir marcação em ${br(day)}</h2>
    <label>Horário<input type="time" name="time" required></label>
    <label>Justificativa<input name="reason" required></label>
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Incluir</button></div>`,
  async f => {
    await api('/api/punches', { method: 'POST', body: { employee_id: emp, day, time: f.get('time'), reason: f.get('reason') } });
    loadReport();
  });
}

// ---------- painel do admin ----------
async function loadPanel() {
  const rows = await api('/api/today');
  $('#panel').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Funcionário</th><th>Situação</th>
    <th>Marcações</th><th>Trabalhado</th><th>Ocorrências</th></tr></thead><tbody>${rows.map(r => `<tr>
    <td>${esc(r.name)}</td><td><span class="badge ${r.status === 'Trabalhando' ? 'ok' : r.status === 'Não registrou' ? 'warn' : ''}">${r.status}</span></td>
    <td class="num">${r.punches.map(p => p.time).join(' ')}</td><td class="num">${hhmm(r.worked)}</td>
    <td>${r.alerts.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Cadastre funcionários na aba Funcionários.</p>';
}

// ---------- funcionários ----------
async function loadEmployees() {
  employees = await api('/api/employees');
  $('#employees').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Nome</th><th>Login</th><th>Perfil</th>
    <th>Jornada</th><th>Dias</th><th>Situação</th><th></th></tr></thead><tbody>${employees.map(e => `<tr>
    <td>${esc(e.name)}</td><td>${esc(e.login)}</td><td>${e.role === 'admin' ? 'Admin' : 'Funcionário'}</td>
    <td class="num">${e.start_time}–${e.end_time}${e.break_minutes ? ` (interv. ${e.break_minutes} min)` : ''}</td><td>${e.work_days.split(',').map(d => DAYS[d]).join(' ')}</td>
    <td>${e.active ? 'Ativo' : 'Inativo'}</td><td><button class="link" data-edit="${e.id}">Editar</button></td></tr>`).join('')}
    </tbody></table></div><br>`;
  document.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => employeeForm(employees.find(e => e.id === Number(b.dataset.edit)))));
}

function employeeForm(e) {
  const isNew = !e;
  e = e || { name: '', login: '', role: 'employee', work_days: '1,2,3,4,5', start_time: '08:00', end_time: '17:00',
    break_minutes: 60, sat_start: '08:00', sat_end: '12:00', active: true };
  const wd = e.work_days.split(',');
  dialog(`<h2>${isNew ? 'Novo funcionário' : 'Editar funcionário'}</h2>
    <label>Nome<input name="name" value="${esc(e.name)}" required></label>
    <label>Login<input name="login" value="${esc(e.login)}" ${isNew ? 'required' : 'disabled'} autocapitalize="none"></label>
    <label>${isNew ? 'Senha' : 'Nova senha (deixe vazio para manter)'}<input name="password" type="password" minlength="6" ${isNew ? 'required' : ''}></label>
    <label>Data de admissão (para calcular as férias)<input name="hire_date" type="date" value="${e.hire_date || ''}"></label>
    <label>Perfil<select name="role"><option value="employee">Funcionário</option><option value="admin" ${e.role === 'admin' ? 'selected' : ''}>Administrador</option></select></label>
    <div class="two-cols"><label>Entrada padrão<input name="start_time" type="time" value="${e.start_time}" required></label>
      <label>Saída padrão<input name="end_time" type="time" value="${e.end_time}" required></label></div>
    <label>Intervalo previsto (min)<input name="break_minutes" type="number" min="0" max="240" value="${e.break_minutes}" required></label>
    <label>Dias de trabalho<span class="days-check">${DAYS.map((d, i) =>
      `<label><input type="checkbox" name="wd" value="${i}" ${wd.includes(String(i)) ? 'checked' : ''}>${d}</label>`).join('')}</span></label>
    <div class="two-cols"><label>Entrada no sábado<input name="sat_start" type="time" value="${e.sat_start}"></label>
      <label>Saída no sábado<input name="sat_end" type="time" value="${e.sat_end}"></label></div>
    ${isNew ? '' : `<label><span><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> Ativo</span></label>`}
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Salvar</button></div>`,
  async f => {
    const body = {
      name: f.get('name'), role: f.get('role'), work_days: f.getAll('wd').join(',') || '1,2,3,4,5',
      start_time: f.get('start_time'), end_time: f.get('end_time'), break_minutes: Number(f.get('break_minutes') || 0),
      sat_start: f.get('sat_start') || '08:00', sat_end: f.get('sat_end') || '12:00', hire_date: f.get('hire_date') || null,
    };
    if (f.get('password')) body.password = f.get('password');
    if (isNew) { body.login = f.get('login'); await api('/api/employees', { method: 'POST', body }); }
    else { body.active = f.get('active') === 'on'; await api(`/api/employees/${e.id}`, { method: 'PUT', body }); }
    await loadEmployees();
    refreshEmpFilter();
  });
}
$('#new-emp').addEventListener('click', () => employeeForm(null));

// ---------- configurações ----------
const SETTING_LABELS = {
  company_name: ['Nome da empresa', 'text'],
  tolerance_daily: ['Tolerância diária (min) — art. 58 §1º', 'number'],
  late_tolerance: ['Tolerância de atraso e saída antecipada (min)', 'number'],
  overtime_rate_weekday: ['Adicional de hora extra em dias normais (%)', 'number'],
  overtime_rate_sunday: ['Adicional em domingos e feriados (%)', 'number'],
  max_daily_overtime: ['Limite de hora extra por dia (min)', 'number'],
  min_break_long: ['Intervalo mínimo para jornada acima de 6h (min)', 'number'],
  min_break_short: ['Intervalo mínimo para jornada de 4h a 6h (min)', 'number'],
  min_interjornada: ['Descanso mínimo entre jornadas (min)', 'number'],
  night_start: ['Início do horário noturno', 'time'],
  night_end: ['Fim do horário noturno', 'time'],
};

async function loadConfig() {
  const s = await api('/api/settings');
  $('#settings-form').innerHTML = Object.entries(SETTING_LABELS).map(([k, [l, type]]) =>
    `<label>${l}<input name="${k}" type="${type}" value="${esc(s[k])}" required></label>`).join('') +
    `<div class="full"><button class="primary">Salvar regras</button> <span id="settings-msg" class="muted"></span></div>`;
  $('#email-form').notify_emails.value = s.notify_emails || '';
  $('#email-form').email_from.value = s.email_from || '';
  $('#email-status').textContent = s._email_ready ? 'Avisos por e-mail ativos.'
    : !s._email_key ? 'Falta configurar a chave do Brevo (BREVO_API_KEY) no Render. Veja o passo a passo em PUBLICAR.md.'
    : 'Preencha os e-mails acima para ativar os avisos.';
  const hs = await api('/api/holidays');
  $('#holidays').innerHTML = hs.map(h => `<li><span>${br(h.day)} — ${esc(h.name)}</span>
    <button class="link danger" data-hday="${h.day}">Remover</button></li>`).join('') || '<li class="muted">Nenhum feriado cadastrado.</li>';
  document.querySelectorAll('[data-hday]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/holidays/${b.dataset.hday}`, { method: 'DELETE' }); loadConfig();
  }));
  const audit = await api('/api/audit');
  $('#audit').innerHTML = audit.length ? `<div class="table-wrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th>
    <th>Funcionário</th><th>Detalhe</th><th>Justificativa</th></tr></thead><tbody>${audit.map(a => `<tr>
    <td class="num">${esc(a.created_at)} UTC</td><td>${esc(a.admin_name)}</td><td>${esc(a.action)}</td><td>${esc(a.employee_name)}</td>
    <td>${esc(a.details)}</td><td>${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhum ajuste feito ainda.</p>';
}

$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
  $('#settings-msg').textContent = 'Salvo.';
});

$('#holiday-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('/api/holidays', { method: 'POST', body: { day: f.get('day'), name: f.get('name') } });
  e.target.reset(); loadConfig();
});

$('#email-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
    $('#email-msg').textContent = 'Salvo.'; loadConfig();
  } catch (err) { $('#email-msg').textContent = err.message; }
});

$('#email-test').addEventListener('click', async () => {
  $('#email-msg').textContent = 'Enviando...';
  try { await api('/api/settings/test-email', { method: 'POST' }); $('#email-msg').textContent = 'E-mail de teste enviado.'; }
  catch (err) { $('#email-msg').textContent = err.message; }
});

// ---------- pedidos de correção ----------
const ACTION_TEXT = { incluir: 'Incluir marcação', alterar: 'Alterar marcação', excluir: 'Excluir marcação' };

function correctionForm(d) {
  const opts = d.punches.map(p => `<option value="${p.id}">${p.time}</option>`).join('');
  dialog(`<h2>Pedir correção de ${br(d.day)}</h2>
    <p class="muted">Marcações do dia: ${d.punches.map(p => p.time).join(', ') || 'nenhuma'}</p>
    <label>O que precisa corrigir?<select name="action" id="corr-action">
      <option value="incluir">Incluir uma marcação que faltou</option>
      ${d.punches.length ? '<option value="alterar">Alterar o horário de uma marcação</option><option value="excluir">Excluir uma marcação errada</option>' : ''}
    </select></label>
    <label id="corr-punch-wrap" class="hidden">Marcação<select name="punch_id">${opts}</select></label>
    <label id="corr-time-wrap">Horário correto<input type="time" name="time"></label>
    <label>Motivo<input name="reason" required placeholder="Ex.: esqueci de registrar a volta do almoço"></label>
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Enviar para aprovação</button></div>`,
  async f => {
    await api('/api/corrections', { method: 'POST', body: {
      day: d.day, action: f.get('action'), punch_id: f.get('punch_id'), time: f.get('time'), reason: f.get('reason') } });
    openTab('solicitacoes');
  });
  const sync = () => {
    const a = $('#corr-action').value;
    $('#corr-punch-wrap').classList.toggle('hidden', a === 'incluir');
    $('#corr-time-wrap').classList.toggle('hidden', a === 'excluir');
  };
  $('#corr-action').addEventListener('change', sync); sync();
}

function describeCorrection(c) {
  if (c.action === 'incluir') return `Incluir ${c.time}`;
  if (c.action === 'alterar') return `Alterar ${c.punch_time || '?'} para ${c.time}`;
  return `Excluir ${c.punch_time || 'marcação'}`;
}

const STATUS_BADGE = { pendente: 'warn', aprovado: 'ok', recusado: '' };

async function loadCorrections() {
  const admin = me.role === 'admin';
  const q = admin ? `?status=${$('#corr-status').value}` : '';
  const rows = await api(`/api/corrections${q}`);
  $('#corrections').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>${admin ? '<th>Funcionário</th>' : ''}
    <th>Dia</th><th>Pedido</th><th>Motivo</th><th>Situação</th><th></th></tr></thead><tbody>${rows.map(c => `<tr>
    ${admin ? `<td>${esc(c.employee_name)}</td>` : ''}<td class="num">${br(c.day)}</td><td>${esc(describeCorrection(c))}</td>
    <td>${esc(c.reason)}</td><td><span class="badge ${STATUS_BADGE[c.status]}">${c.status}</span>
      ${c.review_note ? `<br><span class="muted">${esc(c.review_note)}</span>` : ''}</td>
    <td>${c.status !== 'pendente' ? '' : admin
      ? `<button class="link" data-approve="${c.id}">Aprovar</button> <button class="link danger" data-reject="${c.id}">Recusar</button>`
      : `<button class="link danger" data-cancel="${c.id}">Cancelar</button>`}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhuma solicitação.</p>';
  const review = (id, approve) => dialog(`<h2>${approve ? 'Aprovar' : 'Recusar'} pedido</h2>
    <label>Observação (opcional)<input name="note"></label>
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button>
      <button value="ok" class="${approve ? 'primary' : 'danger'}">${approve ? 'Aprovar e aplicar' : 'Recusar'}</button></div>`,
  async f => {
    await api(`/api/corrections/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note: f.get('note') } });
    loadCorrections(); refreshPendingBadge();
  });
  document.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => review(b.dataset.approve, true)));
  document.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => review(b.dataset.reject, false)));
  document.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/corrections/${b.dataset.cancel}`, { method: 'DELETE' }); loadCorrections();
  }));
}
$('#corr-status').addEventListener('change', loadCorrections);

// ---------- férias ----------
const VAC_BADGE = { pendente: 'warn', aprovado: 'ok', recusado: '', cancelado: '' };

function vacDays(start, end) {
  if (!start || !end || end < start) return 0;
  return Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000) + 1;
}

function describeVacation(v) {
  const parts = [];
  if (v.days) parts.push(`${br(v.start_day)} a ${br(v.end_day)} (${v.days} dias)`);
  if (v.sell_days) parts.push(`vender ${v.sell_days} dia${v.sell_days == 1 ? '' : 's'}`);
  return parts.join(' + ');
}

async function loadVacations() {
  const admin = me.role === 'admin';
  const sums = await api('/api/vacations/summary');
  if (admin) {
    $('#vac-summary').innerHTML = sums.length ? `<div class="table-wrap"><table><thead><tr><th>Funcionário</th><th>Admissão</th>
      <th>Disponível</th><th>Em pedidos</th><th>Tirados</th><th>Vendidos</th><th>Acumulando</th><th>Próximas férias</th><th>Avisos</th></tr></thead>
      <tbody>${sums.map(x => `<tr><td>${esc(x.employee.name)}</td>
      <td class="num">${x.employee.hire_date ? br(x.employee.hire_date) : '<span class="muted">não informada</span>'}</td>
      <td class="num"><b>${x.available}</b></td><td class="num">${x.reserved || ''}</td><td class="num">${x.used || ''}</td>
      <td class="num">${x.sold || ''}</td><td class="num">${x.employee.hire_date ? x.accruing : ''}</td>
      <td>${x.upcoming.filter(v => v.days).map(v => `${br(v.start_day)} a ${br(v.end_day)}`).join('<br>')}</td>
      <td class="error-text">${x.alerts.map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Dias corridos. A cada 12 meses desde a admissão o funcionário ganha 30 dias, que precisam ser tirados nos 12 meses seguintes.</p>`
      : '<p class="muted">Nenhum funcionário ativo.</p>';
  } else {
    const x = sums[0];
    $('#vac-summary').innerHTML = `<div class="stats">${stat('Dias disponíveis', x.available)}${stat('Aguardando aprovação', x.reserved)}
      ${stat('Já tirados', x.used)}${stat('Vendidos', x.sold)}${x.employee.hire_date ? stat('Acumulando no período atual', x.accruing) : ''}</div>
      ${x.nextDeadline ? `<p class="muted">Tire os dias disponíveis até ${br(x.nextDeadline)}.</p>` : ''}
      ${x.upcoming.filter(v => v.days).length ? `<p>Próximas férias: ${x.upcoming.filter(v => v.days).map(v => `<b>${br(v.start_day)} a ${br(v.end_day)}</b>`).join(', ')}</p>` : ''}
      ${x.alerts.length ? `<ul class="alerts">${x.alerts.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}`;
    $('#vac-form').dataset.free = x.available - x.reserved;
    updateVacCount();
  }

  const q = admin ? `?status=${$('#vac-status').value}` : '';
  const rows = await api(`/api/vacations/requests${q}`);
  $('#vac-req-title').textContent = admin ? 'Pedidos de férias' : 'Meus pedidos';
  $('#vac-requests').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>${admin ? '<th>Funcionário</th>' : ''}
    <th>Pedido</th><th>Observação</th><th>Enviado em</th><th>Situação</th><th></th></tr></thead><tbody>${rows.map(v => `<tr>
    ${admin ? `<td>${esc(v.employee_name)}</td>` : ''}<td>${esc(describeVacation(v))}</td><td>${esc(v.note)}</td>
    <td class="num">${br(String(v.created_at).slice(0, 10))}</td>
    <td><span class="badge ${VAC_BADGE[v.status]}">${v.status}</span>
      ${v.review_note ? `<br><span class="muted">${esc(v.review_note)}</span>` : ''}</td>
    <td>${admin
      ? (v.status === 'pendente' ? `<button class="link" data-vapprove="${v.id}">Aprovar</button> <button class="link danger" data-vreject="${v.id}">Recusar</button>`
        : v.status === 'aprovado' ? `<button class="link danger" data-vcancel="${v.id}">Cancelar</button>` : '')
      : (v.status === 'pendente' ? `<button class="link danger" data-vcancel="${v.id}">Cancelar</button>` : '')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhum pedido de férias.</p>';

  const review = (id, approve) => dialog(`<h2>${approve ? 'Aprovar' : 'Recusar'} férias</h2>
    <label>Observação (opcional)<input name="note"></label>
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button>
      <button value="ok" class="${approve ? 'primary' : 'danger'}">${approve ? 'Aprovar' : 'Recusar'}</button></div>`,
  async f => {
    await api(`/api/vacations/requests/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note: f.get('note') } });
    loadVacations(); refreshPendingBadge();
  });
  document.querySelectorAll('[data-vapprove]').forEach(b => b.addEventListener('click', () => review(b.dataset.vapprove, true)));
  document.querySelectorAll('[data-vreject]').forEach(b => b.addEventListener('click', () => review(b.dataset.vreject, false)));
  document.querySelectorAll('[data-vcancel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(admin ? 'Cancelar essas férias? Os dias voltam para o saldo.' : 'Cancelar este pedido?')) return;
    await api(`/api/vacations/requests/${b.dataset.vcancel}`, { method: 'DELETE' });
    loadVacations(); refreshPendingBadge();
  }));
}

function updateVacCount() {
  const f = $('#vac-form');
  const days = vacDays(f.start_day.value, f.end_day.value), sell = Number(f.sell_days.value || 0);
  const free = Number(f.dataset.free || 0);
  $('#vac-count').textContent = days || sell
    ? `Total do pedido: ${days ? `${days} dia${days === 1 ? '' : 's'} de descanso` : ''}${days && sell ? ' + ' : ''}${sell ? `${sell} vendido${sell === 1 ? '' : 's'}` : ''}. Saldo depois: ${free - days - sell} dia(s).`
    : `Você pode pedir até ${Math.max(0, free)} dia(s).`;
}

$('#vac-form').addEventListener('input', updateVacCount);
$('#vac-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/vacations/requests', { method: 'POST', body: {
      start_day: f.get('start_day') || null, end_day: f.get('end_day') || null,
      sell_days: Number(f.get('sell_days') || 0), note: f.get('note') } });
    e.target.reset();
    $('#vac-msg').textContent = 'Pedido enviado. O administrador foi avisado.';
    loadVacations();
  } catch (err) { $('#vac-msg').textContent = err.message; }
});
$('#vac-status').addEventListener('change', loadVacations);

const empOptions = () => employees.filter(e => e.active && e.role === 'employee').map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');

$('#vac-new').addEventListener('click', () => dialog(`<h2>Lançar férias</h2>
  <p class="muted">Férias lançadas pelo administrador já entram aprovadas. Pode usar datas passadas.</p>
  <label>Funcionário<select name="employee_id" required>${empOptions()}</select></label>
  <div class="two-cols"><label>Início<input type="date" name="start_day"></label><label>Fim<input type="date" name="end_day"></label></div>
  <label>Dias vendidos<input type="number" name="sell_days" min="0" max="10" value="0"></label>
  <label>Observação (opcional)<input name="note"></label>
  <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Lançar</button></div>`,
async f => {
  await api('/api/vacations/requests', { method: 'POST', body: { employee_id: f.get('employee_id'),
    start_day: f.get('start_day') || null, end_day: f.get('end_day') || null, sell_days: Number(f.get('sell_days') || 0), note: f.get('note') } });
  $('#vac-status').value = 'aprovado';
  loadVacations();
}));

$('#vac-adjust').addEventListener('click', () => dialog(`<h2>Ajustar saldo de férias</h2>
  <p class="muted">Use para dias tirados antes de usar o app (número negativo) ou para somar dias combinados (positivo).</p>
  <label>Funcionário<select name="employee_id" required>${empOptions()}</select></label>
  <label>Dias<input type="number" name="days" required placeholder="Ex.: -10 ou 5"></label>
  <label>Motivo<input name="reason" required></label>
  <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Salvar</button></div>`,
async f => {
  await api('/api/vacations/adjustments', { method: 'POST', body: { employee_id: f.get('employee_id'), days: Number(f.get('days')), reason: f.get('reason') } });
  loadVacations();
}));

// ---------- jornadas especiais ----------
async function loadExceptions() {
  const rows = await api(`/api/exceptions?from=${$('#exc-from').value}&to=${$('#exc-to').value}`);
  $('#exceptions').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Funcionário</th>
    <th>Jornada</th><th>Motivo</th><th></th></tr></thead><tbody>${rows.map(x => `<tr><td class="num">${br(x.day)}</td>
    <td>${x.employee_name ? esc(x.employee_name) : 'Todos'}</td>
    <td class="num">${x.day_off ? 'Folga' : `${x.start_time}–${x.end_time}${x.break_minutes ? ` (interv. ${x.break_minutes} min)` : ''}`}</td>
    <td>${esc(x.reason)}</td><td><button class="link danger" data-exc="${x.id}">Remover</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhuma jornada especial no período.</p>';
  document.querySelectorAll('[data-exc]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/exceptions/${b.dataset.exc}`, { method: 'DELETE' }); loadExceptions();
  }));
}
$('#exc-load').addEventListener('click', loadExceptions);
$('#exc-off').addEventListener('change', e => document.querySelectorAll('.exc-time').forEach(l => l.classList.toggle('hidden', e.target.checked)));
$('#exc-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/api/exceptions', { method: 'POST', body: {
      employee_id: f.get('employee_id'), day: f.get('day'), until: f.get('until'), day_off: f.get('day_off') === 'on',
      start_time: f.get('start_time'), end_time: f.get('end_time'), break_minutes: f.get('break_minutes'), reason: f.get('reason') } });
    $('#exc-msg').textContent = `Salvo para ${r.days} dia(s).`;
    loadExceptions();
  } catch (err) { $('#exc-msg').textContent = err.message; }
});

// ---------- registro de ocorrências ----------
const NOTE_KINDS = ['Atestado médico', 'Falta justificada', 'Atraso justificado', 'Saída autorizada', 'Folga compensada', 'Advertência', 'Outro'];

function occQuery() {
  const q = new URLSearchParams({ from: $('#occ-from').value, to: $('#occ-to').value });
  if (me.role === 'admin') q.set('employee', $('#occ-emp').value);
  return q.toString();
}

async function loadOccurrences() {
  const admin = me.role === 'admin';
  const rows = await api(`/api/occurrences?${occQuery()}`);
  $('#occurrences').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Dia</th>
    ${admin ? '<th>Funcionário</th>' : ''}<th>Jornada prevista</th><th>Marcações</th><th>Ocorrências</th><th>Justificativa</th>
    ${admin ? '<th></th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr class="${r.alerts.length ? 'alert' : ''}">
    <td class="num">${br(r.day)}</td><td>${r.weekday}</td>${admin ? `<td>${esc(r.employee.name)}</td>` : ''}
    <td class="num">${r.scheduleStart ? `${r.scheduleStart}–${r.scheduleEnd}` : 'Folga'}</td>
    <td class="num">${r.punches.map(p => p.time).join(' ')}</td>
    <td>${[r.special ? `Jornada especial: ${r.special}` : '', ...r.alerts].filter(Boolean).map(esc).join('<br>')}</td>
    <td>${r.notes.map(n => `${esc(noteText(n))}${admin ? ` <button class="link danger" data-note="${n.id}" title="Remover">×</button>` : ''}`).join('<br>')}</td>
    ${admin ? `<td><button class="link" data-justify="${r.employee.id}|${r.day}">Justificar</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Nenhuma ocorrência no período.</p>';
  document.querySelectorAll('[data-justify]').forEach(b => b.addEventListener('click', () => {
    const [emp, day] = b.dataset.justify.split('|');
    dialog(`<h2>Justificar ocorrência de ${br(day)}</h2>
      <label>Tipo<select name="kind">${NOTE_KINDS.map(k => `<option>${k}</option>`).join('')}</select></label>
      <label>Observação<input name="note"></label>
      <label><span><input type="checkbox" name="excused"> Abonar o dia (não conta falta, atraso nem débito)</span></label>
      <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="ok" class="primary">Salvar</button></div>`,
    async f => {
      await api('/api/day-notes', { method: 'POST', body: { employee_id: emp, day, kind: f.get('kind'), note: f.get('note'), excused: f.get('excused') === 'on' } });
      loadOccurrences();
    });
  }));
  document.querySelectorAll('[data-note]').forEach(b => b.addEventListener('click', async () => {
    await api(`/api/day-notes/${b.dataset.note}`, { method: 'DELETE' }); loadOccurrences();
  }));
}
$('#occ-load').addEventListener('click', loadOccurrences);
$('#occ-pdf').addEventListener('click', () => { location.href = `/api/occurrences.pdf?${occQuery()}`; });
$('#occ-xlsx').addEventListener('click', () => { location.href = `/api/occurrences.xlsx?${occQuery()}`; });

// ---------- conta ----------
$('#pass-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
    $('#pass-msg').textContent = 'Senha alterada.'; e.target.reset();
  } catch (err) { $('#pass-msg').textContent = err.message; }
});

// ---------- inicialização ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
api('/api/me').then(u => { me = u; start(); }).catch(showLogin);
