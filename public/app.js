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
    ? [['painel', 'Painel'], ['espelho', 'Relatórios'], ['funcionarios', 'Funcionários'], ['config', 'Configurações'], ['conta', 'Conta']]
    : [['ponto', 'Bater ponto'], ['espelho', 'Meu espelho'], ['conta', 'Conta']];
}

function openTab(name) {
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hidden', s.dataset.tab !== name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ({ ponto: loadToday, espelho: loadReport, painel: loadPanel, funcionarios: loadEmployees, config: loadConfig }[name] || (() => {}))();
}

function refreshEmpFilter() {
  $('#emp-filter').innerHTML = '<option value="all">Todos</option>' +
    employees.filter(e => e.role === 'employee' && e.active).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
}

async function start() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#who').textContent = me.name;
  const tabs = tabsFor(me.role);
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
  $('#from').value = today().slice(0, 8) + '01';
  $('#to').value = today();
  if (me.role === 'admin') {
    employees = await api('/api/employees');
    $('#emp-filter-wrap').classList.remove('hidden');
    refreshEmpFilter();
  }
  openTab(tabs[0][0]);
}

// ---------- bater ponto ----------
setInterval(() => {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('#date').textContent = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}, 1000);

function stat(label, value) { return `<div class="stat"><b>${value}</b><span>${label}</span></div>`; }

async function loadToday() {
  const r = await api(`/api/my/report?from=${today()}&to=${today()}`);
  const d = r.days[0];
  const labels = ['Entrada', 'Saída intervalo', 'Volta intervalo', 'Saída'];
  $('#today-punches').innerHTML = d.punches.length
    ? d.punches.map((p, i) => `<span class="chip">${labels[i] || (i % 2 ? 'Saída' : 'Entrada')}: ${p.time}</span>`).join('')
    : '<span class="muted">Nenhuma marcação hoje.</span>';
  $('#today-summary').innerHTML = stat('Trabalhado', hhmm(d.worked)) + stat('Previsto', hhmm(d.expected)) +
    stat('Intervalo', hhmm(d.breakTotal)) + stat('Hora extra', hhmm(d.overtime50 + d.overtime100));
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
      const add = admin ? ` <button class="link add-punch" data-day="${d.day}" data-emp="${r.employee.id}">+</button>` : '';
      const notes = [d.holiday ? `Feriado: ${d.holiday}` : '', ...d.alerts].filter(Boolean).map(esc).join('<br>');
      return `<tr class="${cls}"><td class="num">${br(d.day)}</td><td>${d.weekday}</td><td class="num">${punches}${add}</td>
        <td class="num">${t(d.expected)}</td><td class="num">${t(d.worked)}</td><td class="num">${t(d.breakTotal)}</td>
        <td class="num">${t(d.overtime50)}</td><td class="num">${t(d.overtime100)}</td><td class="num">${t(d.deficit)}</td>
        <td class="num">${t(d.night)}</td><td>${notes}</td></tr>`;
    }).join('');
    return `<h2>${esc(r.employee.name)}</h2>
      <div class="stats">${stat('Trabalhado', hhmm(T.worked))}${stat('Previsto', hhmm(T.expected))}
        ${stat(`HE ${r.rates.weekday}%`, hhmm(T.overtime50))}${stat(`HE ${r.rates.sunday}%`, hhmm(T.overtime100))}
        ${stat('Débito', hhmm(T.deficit))}${stat('Saldo', hhmm(T.balance))}${stat('Noturno', hhmm(T.night))}
        ${stat('Faltas', T.absences)}</div>
      <div class="table-wrap"><table><thead><tr><th>Data</th><th>Dia</th><th>Marcações</th><th>Previsto</th><th>Trab.</th>
        <th>Interv.</th><th>HE 50%</th><th>HE 100%</th><th>Débito</th><th>Noturno</th><th>Ocorrências</th></tr></thead>
        <tbody>${rows}</tbody></table></div><br>`;
  }).join('') || '<p class="muted">Nenhum funcionário cadastrado.</p>';

  document.querySelectorAll('.punch-edit').forEach(el => el.addEventListener('click', () => editPunch(el.dataset)));
  document.querySelectorAll('.add-punch').forEach(el => el.addEventListener('click', () => addPunch(el.dataset)));
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
    <td class="num">${hhmm(e.daily_minutes)}</td><td>${e.work_days.split(',').map(d => DAYS[d]).join(' ')}</td>
    <td>${e.active ? 'Ativo' : 'Inativo'}</td><td><button class="link" data-edit="${e.id}">Editar</button></td></tr>`).join('')}
    </tbody></table></div><br>`;
  document.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => employeeForm(employees.find(e => e.id === Number(b.dataset.edit)))));
}

function employeeForm(e) {
  const isNew = !e;
  e = e || { name: '', login: '', role: 'employee', daily_minutes: 480, work_days: '1,2,3,4,5', saturday_minutes: 240, active: true };
  const wd = e.work_days.split(',');
  dialog(`<h2>${isNew ? 'Novo funcionário' : 'Editar funcionário'}</h2>
    <label>Nome<input name="name" value="${esc(e.name)}" required></label>
    <label>Login<input name="login" value="${esc(e.login)}" ${isNew ? 'required' : 'disabled'} autocapitalize="none"></label>
    <label>${isNew ? 'Senha' : 'Nova senha (deixe vazio para manter)'}<input name="password" type="password" minlength="6" ${isNew ? 'required' : ''}></label>
    <label>Perfil<select name="role"><option value="employee">Funcionário</option><option value="admin" ${e.role === 'admin' ? 'selected' : ''}>Administrador</option></select></label>
    <label>Jornada diária (horas)<input name="daily" type="time" value="${hhmm(e.daily_minutes)}" required></label>
    <label>Dias de trabalho<span class="days-check">${DAYS.map((d, i) =>
      `<label><input type="checkbox" name="wd" value="${i}" ${wd.includes(String(i)) ? 'checked' : ''}>${d}</label>`).join('')}</span></label>
    <label>Jornada no sábado (se trabalhar)<input name="sat" type="time" value="${hhmm(e.saturday_minutes)}"></label>
    ${isNew ? '' : `<label><span><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> Ativo</span></label>`}
    <div class="row-actions"><button value="cancel" formnovalidate>Cancelar</button><button value="save" class="primary">Salvar</button></div>`,
  async f => {
    const toMin = v => { const [h, m] = String(v || '0:0').split(':').map(Number); return h * 60 + m; };
    const body = {
      name: f.get('name'), role: f.get('role'), daily_minutes: toMin(f.get('daily')),
      saturday_minutes: toMin(f.get('sat')), work_days: f.getAll('wd').join(',') || '1,2,3,4,5',
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
