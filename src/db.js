// Camada de banco de dados: usa Postgres quando DATABASE_URL está definida (ex.: Neon)
// e SQLite embutido caso contrário (desenvolvimento local ou servidor com disco persistente).
// As consultas usam "?" como marcador; no Postgres eles viram $1, $2...
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const usePg = !!process.env.DATABASE_URL;

const SCHEMA = (pk, bigint, now) => `
CREATE TABLE IF NOT EXISTS employees (
  id ${pk},
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',          -- 'employee' | 'admin'
  daily_minutes INTEGER NOT NULL DEFAULT 480,     -- jornada diária contratada
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5',    -- 0=domingo ... 6=sábado
  saturday_minutes INTEGER NOT NULL DEFAULT 240,  -- jornada do sábado, se trabalhar
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${now}
);

CREATE TABLE IF NOT EXISTS punches (
  id ${pk},
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  ts TEXT NOT NULL,                 -- ISO 8601 com fuso local
  day TEXT NOT NULL,                -- YYYY-MM-DD no fuso da empresa
  source TEXT NOT NULL DEFAULT 'web',
  ip TEXT,
  user_agent TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${now}
);
CREATE INDEX IF NOT EXISTS idx_punches_emp_day ON punches(employee_id, day);

CREATE TABLE IF NOT EXISTS audit_log (
  id ${pk},
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  punch_id INTEGER,
  employee_id INTEGER,
  details TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT ${now}
);

CREATE TABLE IF NOT EXISTS holidays (
  day TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  expires_at ${bigint} NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Jornada diferente da padrão em dias específicos (employee_id NULL = todos os funcionários).
CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id ${pk},
  employee_id INTEGER REFERENCES employees(id),
  day TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  day_off INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT ${now}
);
CREATE INDEX IF NOT EXISTS idx_exceptions_day ON schedule_exceptions(day);

-- Pedidos de correção feitos pelo funcionário, aprovados ou recusados pelo admin.
CREATE TABLE IF NOT EXISTS correction_requests (
  id ${pk},
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  day TEXT NOT NULL,
  action TEXT NOT NULL,            -- 'incluir' | 'alterar' | 'excluir'
  punch_id INTEGER,
  time TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',   -- 'pendente' | 'aprovado' | 'recusado'
  reviewed_by INTEGER,
  review_note TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT ${now}
);

-- Justificativas de ocorrências (atestado, falta justificada...). excused = 1 abona o dia.
CREATE TABLE IF NOT EXISTS day_notes (
  id ${pk},
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  excused INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT ${now}
);
CREATE INDEX IF NOT EXISTS idx_day_notes ON day_notes(employee_id, day);
`;

// Colunas adicionadas depois da primeira versão (o banco já publicado é atualizado na inicialização).
const NEW_COLUMNS = [
  ['employees', 'start_time', "TEXT NOT NULL DEFAULT '08:00'"],
  ['employees', 'end_time', "TEXT NOT NULL DEFAULT '17:00'"],
  ['employees', 'break_minutes', 'INTEGER NOT NULL DEFAULT 60'],
  ['employees', 'sat_start', "TEXT NOT NULL DEFAULT '08:00'"],
  ['employees', 'sat_end', "TEXT NOT NULL DEFAULT '12:00'"],
];

let db;

if (usePg) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  db = {
    kind: 'postgres',
    async all(sql, params = []) { return (await pool.query(toPg(sql), params)).rows; },
    async get(sql, params = []) { return (await pool.query(toPg(sql), params)).rows[0]; },
    async run(sql, params = []) { await pool.query(toPg(sql), params); },
    async exec(sql) { await pool.query(sql); },
    async hasColumn(table, col) {
      return !!(await pool.query('SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [table, col])).rows[0];
    },
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new DatabaseSync(path.join(DATA_DIR, 'ponto.db'));
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db = {
    kind: 'sqlite',
    async all(sql, params = []) { return sqlite.prepare(sql).all(...params); },
    async get(sql, params = []) { return sqlite.prepare(sql).get(...params); },
    async run(sql, params = []) { sqlite.prepare(sql).run(...params); },
    async exec(sql) { sqlite.exec(sql); },
    async hasColumn(table, col) {
      return sqlite.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    },
  };
}

const DEFAULT_SETTINGS = {
  company_name: 'Stazzy',
  tolerance_per_punch: '5',        // CLT art. 58 §1º: 5 min por marcação
  tolerance_daily: '10',           // ... até 10 min diários
  overtime_rate_weekday: '50',     // % adicional em dias normais
  overtime_rate_sunday: '100',     // % adicional domingos e feriados
  max_daily_overtime: '120',       // limite legal: 2h extras/dia
  min_break_long: '60',            // jornada > 6h: intervalo mínimo 1h
  min_break_short: '15',           // jornada > 4h e ≤ 6h: 15 min
  min_interjornada: '660',         // 11h entre jornadas
  night_start: '22:00',            // adicional noturno 22h-5h
  night_end: '05:00',
  late_tolerance: '10',            // minutos de atraso/saída antecipada tolerados
  notify_emails: '',               // e-mails dos administradores, separados por vírgula
  email_from: '',                  // remetente verificado no Brevo
};

async function init() {
  await db.exec(usePg
    ? SCHEMA('SERIAL PRIMARY KEY', 'BIGINT', "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))")
    : SCHEMA('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER', "(datetime('now'))"));

  for (const [table, col, def] of NEW_COLUMNS) {
    if (!(await db.hasColumn(table, col))) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
  }

  // Cria o administrador inicial na primeira execução.
  const { n } = await db.get("SELECT COUNT(*) AS n FROM employees WHERE role = 'admin'");
  if (Number(n) === 0) {
    const login = process.env.ADMIN_LOGIN || 'admin';
    const pass = process.env.ADMIN_PASSWORD || 'admin123';
    await db.run('INSERT INTO employees (name, login, password_hash, role) VALUES (?, ?, ?, ?)',
      ['Administrador', login, bcrypt.hashSync(pass, 10), 'admin']);
    console.log(`Administrador criado: login "${login}". Troque a senha no primeiro acesso.`);
  }
  console.log(`Banco de dados: ${db.kind}`);
}

async function getSettings() {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

module.exports = { db, init, getSettings, DEFAULT_SETTINGS };
