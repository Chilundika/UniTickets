'use strict';
// Postgres. In production DATABASE_URL points at Neon (or Supabase). Without it, an in-process
// Postgres (PGlite) is used, so local development and tests need no database server.
//
// Queries are written with ? placeholders and converted to $1, $2 ... here.
// Inside tx(), always use the handle passed to the callback, never `db`.
const fs = require('node:fs');
const path = require('node:path');
const { ticketNumber, uuid } = require('./lib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

let raw; // { query(sql, params) -> rows, exec(sql), transaction(fn(query)) }
if (process.env.DATABASE_URL) {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number);   // BIGINT / COUNT(*) as JS numbers (epoch ms fit safely)
  pg.types.setTypeParser(1700, Number); // NUMERIC (AVG, ROUND)
  // Small pool: on Vercel each function instance keeps a few connections to the provider's pooler.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10000 });
  raw = {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(async (sql, params) => (await c.query(sql, params)).rows);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    end: () => pool.end(),
  };
} else {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(DATA_DIR, 'pglite');
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir, { parsers: { 20: Number, 1700: Number } });
  raw = {
    query: async (sql, params) => (await lite.query(sql, params)).rows,
    exec: (sql) => lite.exec(sql),
    transaction: (fn) => lite.transaction((t) => fn(async (sql, params) => (await t.query(sql, params)).rows)),
    end: () => lite.close(),
  };
}

// Handle with the same helpers for the pool and for a transaction.
const handle = (query) => ({
  all: (sql, ...p) => query(toPg(sql), p),
  get: async (sql, ...p) => (await query(toPg(sql), p))[0],
  run: (sql, ...p) => query(toPg(sql), p),
});
const db = handle(raw.query);
const tx = (fn) => raw.transaction((query) => fn(handle(query)));

// ---------- Schema (run by scripts/setup-db.js, which Vercel runs on every build) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,            -- IT-<Staff ID>, e.g. IT-CU411
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('it','admin')),
  pw_hash TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  totp_secret TEXT,                          -- confirmed 2FA secret (admins)
  totp_pending TEXT,                         -- secret shown during enrolment
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,                  -- SHA-256 of the cookie value
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL,
  absolute_expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,                       -- UUID, globally unique
  seq BIGINT UNIQUE NOT NULL,                -- global counter, guarantees unique number
  number TEXT NOT NULL,                      -- display number, e.g. B07
  requester_no TEXT,                         -- NULL when consent = NO
  email TEXT,
  phone TEXT,
  consent INTEGER NOT NULL,                  -- 1 yes / 0 no
  consent_reason TEXT,
  consent_at BIGINT NOT NULL,
  tracked INTEGER NOT NULL,                  -- 0 = "Untracked"
  category TEXT NOT NULL DEFAULT 'Other',
  issue TEXT NOT NULL,
  location TEXT,                             -- from QR code, e.g. Library
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'New',
  assigned_to INTEGER REFERENCES users(id),
  duplicate_of TEXT,
  widespread INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  opened_at BIGINT NOT NULL,                 -- created or last reopened; escalation clock
  resolved_at BIGINT,
  reminded_at BIGINT,
  escalated_at BIGINT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  rating_comment TEXT,
  anonymised INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tickets_number ON tickets(number);
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS ix_tickets_created ON tickets(created_at);

CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,                       -- IT-CU411, system, requester, Temporal user
  type TEXT NOT NULL,                        -- status | note | assign | referral | created
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  is_public INTEGER NOT NULL DEFAULT 0       -- 1 = visible to the requester
);
CREATE INDEX IF NOT EXISTS ix_events_ticket ON ticket_events(ticket_id);

-- File contents live in Cloudflare R2 (or a local folder in development); only metadata here.
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS referral_links (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,           -- only the hash is stored
  department TEXT NOT NULL REFERENCES departments(code),
  surname TEXT NOT NULL,                     -- upper case
  created_by INTEGER REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_ymd TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES referral_links(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  description TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL, ticket_id TEXT, created_at BIGINT NOT NULL, read_at BIGINT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL, created_at BIGINT NOT NULL, sent_at BIGINT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at BIGINT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, details TEXT, ip TEXT
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Shared rate-limit counters (serverless instances share no memory). Keys are hashed.
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at BIGINT NOT NULL);
`;

const DEFAULT_SETTINGS = {
  // Verify against the official Zambia gazette each year.
  holidays: ['2026-01-01', '2026-03-09', '2026-03-12', '2026-04-03', '2026-04-04', '2026-04-06',
    '2026-04-28', '2026-05-01', '2026-05-25', '2026-07-06', '2026-07-07', '2026-08-03',
    '2026-10-19', '2026-10-24', '2026-12-25'],
  categories: ['Network', 'Email', 'Student Portal', 'Hardware', 'Software', 'Account/Password', 'Other'],
  reminderWorkingDays: 2,
  escalationWorkingDays: 3,
  linkWorkingDays: 5,
  slaHours: { Urgent: 4, High: 8, Medium: 24, Low: 72 },
  widespreadThreshold: 5,        // same category within 2 hours
  retentionDays: 730,            // contact details removed 2 years after resolution
  cannedReplies: [
    'Thank you, we have received your request and are looking into it.',
    'Please restart your device and try again, then let us know if the problem continues.',
    'Your password has been reset. Check your university email for the temporary password.',
  ],
};

// Create tables and seed defaults. Safe to run any number of times.
async function setup() {
  await raw.exec(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', k, JSON.stringify(v));
  }
  if (!(await db.get('SELECT 1 FROM departments LIMIT 1'))) {
    for (const [code, name, email] of [['ACCOUNTS', 'Accounts', 'accounts@example.edu'], ['SOB', 'School of Business', 'sob@example.edu'],
      ['SOH', 'School of Humanities', 'soh@example.edu'], ['SOE', 'School of Engineering', 'soe@example.edu']]) {
      await db.run('INSERT INTO departments(code, name, email) VALUES (?, ?, ?)', code, name, email);
    }
  }
  if (!(await db.get('SELECT 1 FROM kb_articles LIMIT 1'))) {
    const now = Date.now();
    for (const [title, body] of [
      ['I forgot my portal password', 'Use "Forgot password" on the Student Portal login page. The reset link goes to your university email. If you cannot access that email, submit a ticket.'],
      ['Wi-Fi connects but there is no internet', 'Forget the campus network on your device, reconnect, and sign in again with your student/staff number. If several people near you have the same problem, submit one ticket and mention the location.'],
      ['Cannot open university email on my phone', 'Remove the account from your mail app and add it again using the "Work or school" option. Make sure the date and time on your phone are correct.'],
    ]) await db.run('INSERT INTO kb_articles(title, body, updated_at) VALUES (?, ?, ?)', title, body, now);
  }
  await db.run("INSERT INTO counters(name, value) VALUES ('ticket', 0) ON CONFLICT (name) DO NOTHING");
}

// ---------- Helpers ----------
async function getSetting(key, c = db) {
  const row = await c.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
}
function setSetting(key, value, c = db) {
  return c.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// Reserve the next ticket number. Must run inside tx(): the UPDATE locks the counter row
// until commit, so simultaneous submissions queue up and can never get the same number.
async function nextTicketNumber(t) {
  const { value } = await t.get("UPDATE counters SET value = value + 1 WHERE name = 'ticket' RETURNING value");
  const seq = value - 1;
  return { id: uuid(), seq, number: ticketNumber(seq) };
}

function audit(actor, action, details = '', ip = '', c = db) {
  return c.run('INSERT INTO audit_log(at, actor, action, details, ip) VALUES (?, ?, ?, ?, ?)',
    Date.now(), actor, action, typeof details === 'string' ? details : JSON.stringify(details), ip || '');
}

function logEvent(ticketId, actor, type, { from = null, to = null, note = null, pub = 0 } = {}, c = db) {
  return c.run('INSERT INTO ticket_events(ticket_id, at, actor, type, from_status, to_status, note, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ticketId, Date.now(), actor, type, from, to, note, pub ? 1 : 0);
}

module.exports = { db, tx, setup, end: () => raw.end(), DATA_DIR, getSetting, setSetting, nextTicketNumber, audit, logEvent };
