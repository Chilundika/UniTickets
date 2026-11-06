'use strict';
// End-to-end API test against a throwaway in-memory Postgres (PGlite).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-test-'));
process.env.PGLITE_DIR = 'memory://';
process.env.CRON_SECRET = 'test-cron-secret-123456';
delete process.env.DATABASE_URL;
const app = require('../server/app');
const { db, setup, end } = require('../server/db');
const L = require('../server/lib');
const jobs = require('../server/jobs');
const T = require('../server/tickets');
const { checkConfig } = require('../server/config');

let server, base, cookie = '';
async function req(method, url, body, { auth = true, csrf = true, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (csrf) h['X-Requested-With'] = 'fetch';
  if (auth && cookie) h.Cookie = cookie;
  const r = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function captcha() {
  const { body } = await req('GET', '/api/captcha');
  const [a, b] = body.question.match(/\d+/g).map(Number);
  return { captchaToken: body.token, captchaAnswer: String(a + b) };
}
const intake = { requesterNo: 'STU1001', email: 'student@example.edu', phone: '+260971234567', issue: 'Cannot log in to the portal.', category: 'Student Portal' };
const bulk = (i) => ({ consent: false, reason: 'x', issue: `bulk ${i}`, category: 'Other', requesterNo: null, email: null, phone: null, location: null });

test.before(async () => {
  await setup();
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
  const ins = 'INSERT INTO users(username, full_name, email, role, pw_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  await db.run(ins, 'IT-CU411', 'Test IT', 'it@example.edu', 'it', L.hashPassword('it-password-1'), 1, Date.now());
  await db.run(ins, 'IT-ADM01', 'Test Admin', 'admin@example.edu', 'admin', L.hashPassword('admin-password-1'), 0, Date.now());
});
test.after(async () => { server.close(); await end(); });

test('consent YES creates a tracked ticket A01', async () => {
  const r = await req('POST', '/api/tickets', { ...intake, consent: 'yes', ...(await captcha()) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { number: 'A01', tracked: true });
});

test('consent NO creates an untracked ticket and stores no personal data', async () => {
  const r = await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU2002', consent: 'no', reason: 'I prefer not to share.', ...(await captcha()) });
  assert.equal(r.body.number, 'A02');
  assert.equal(r.body.tracked, false);
  const t = await db.get("SELECT * FROM tickets WHERE number = 'A02'");
  assert.equal(t.email, null);
  assert.equal(t.phone, null);
  assert.equal(t.requester_no, null);
  assert.equal(t.consent_reason, 'I prefer not to share.');
  assert.ok(t.consent_at);
});

test('validation and CAPTCHA are enforced', async () => {
  let r = await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU3003', consent: 'yes', captchaToken: 'x', captchaAnswer: '1' });
  assert.equal(r.body.field, 'captcha');
  r = await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU3003', phone: '0971234567', consent: 'yes', ...(await captcha()) });
  assert.equal(r.body.field, 'phone');
});

test('attachments are stored outside the database and only staff can download them', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
  const r = await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU4004', consent: 'yes', ...(await captcha()),
    attachment: { name: 'shot.png', mime: 'image/png', data: png.toString('base64') } });
  assert.equal(r.status, 200);
  const a = await db.get('SELECT a.* FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE t.number = ?', r.body.number);
  assert.equal(a.size, png.length);
  assert.ok(a.storage_key.startsWith('attachments/'));
  const fake = await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU4005', consent: 'yes', ...(await captcha()),
    attachment: { name: 'evil.png', mime: 'image/png', data: Buffer.from('MZ not an image').toString('base64') } });
  assert.equal(fake.body.field, 'attachment');
});

test('per-student limit: 3 tickets per 10 minutes, while one shared IP is not blocked', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU9999', consent: 'yes', ...(await captcha()) })).status, 200);
  }
  assert.equal((await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU9999', consent: 'yes', ...(await captcha()) })).status, 429);
  // Another student on the same IP (campus Wi-Fi) can still submit.
  assert.equal((await req('POST', '/api/tickets', { ...intake, requesterNo: 'STU8888', consent: 'yes', ...(await captcha()) })).status, 200);
});

test('tracking needs ticket number + student number, and consent', async () => {
  assert.equal((await req('POST', '/api/track', { number: 'a01', requesterNo: 'stu1001' })).status, 200);
  assert.equal((await req('POST', '/api/track', { number: 'A01', requesterNo: 'WRONG' })).status, 404);
  assert.equal((await req('POST', '/api/track', { number: 'A02', requesterNo: 'STU2002' })).status, 404);
});

test('guessing student numbers for one ticket is cut off after 10 tries', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await req('POST', '/api/track', { number: 'A03', requesterNo: `GUESS${i}` });
  assert.equal(last.status, 429);
});

test('ticket numbers stay unique under concurrent submissions', async () => {
  const { c: before } = await db.get('SELECT COUNT(*) c FROM tickets');
  await Promise.all(Array.from({ length: 60 }, (_, i) => T.createTicket(bulk(i)).then((x) => x.notifications)));
  const rows = await db.all('SELECT number FROM tickets');
  assert.equal(rows.length, before + 60);
  assert.equal(new Set(rows.map((r) => r.number)).size, rows.length);
  assert.ok(rows.some((r) => r.number === 'B01'));
});

test('staff login, forced password change, RBAC and CSRF', async () => {
  assert.equal((await req('GET', '/api/tickets')).status, 401);
  assert.equal((await req('POST', '/api/login', { username: 'IT-CU411', password: 'nope' })).status, 401);
  const r = await req('POST', '/api/login', { username: 'it-cu411', password: 'it-password-1' });
  assert.equal(r.body.mustChangePassword, true);
  assert.equal((await req('GET', '/api/tickets')).status, 403);
  assert.equal((await req('POST', '/api/me/password', { current: 'it-password-1', next: 'a-much-better-password' })).status, 200);
  assert.equal((await req('GET', '/api/tickets')).status, 200);
  assert.equal((await req('GET', '/api/users')).status, 403); // IT user is not admin
  const t = await db.get("SELECT id FROM tickets WHERE number = 'A01'");
  assert.equal((await req('PATCH', `/api/tickets/${t.id}`, { status: 'In Progress' }, { csrf: false })).status, 403);
  assert.equal((await req('PATCH', `/api/tickets/${t.id}`, { status: 'In Progress', note: 'Looking', public: true })).status, 200);
  const today = await req('GET', '/api/stats/today');
  assert.equal(typeof today.body.received, 'number');
  const a = await db.get("SELECT t.id FROM tickets t JOIN attachments a ON a.ticket_id = t.id LIMIT 1");
  const dl = await fetch(`${base}/api/tickets/${a.id}/attachment`, { headers: { Cookie: cookie } });
  assert.equal(dl.status, 200);
  assert.equal((await dl.arrayBuffer()).byteLength, 104);
});

test('department referral link: token + department + surname, Temporal user resolves', async () => {
  const t = await db.get("SELECT id FROM tickets WHERE number = 'A01'");
  const r = await req('POST', `/api/tickets/${t.id}/refer`, { department: 'SOH', surname: 'Muchindu', description: 'Fees query, not IT.' });
  assert.equal(r.status, 200);
  const token = new URL(r.body.url).hash.split('t=')[1];
  assert.ok(token.length >= 40);
  assert.equal((await db.get('SELECT status FROM tickets WHERE id = ?', t.id)).status, 'Referred to Department');

  const anon = { auth: false };
  assert.equal((await req('POST', '/api/ref/open', { token, department: 'SOH', surname: 'BANDA' }, anon)).status, 401);
  assert.equal((await req('POST', '/api/ref/open', { token: 'guess', department: 'SOH', surname: 'MUCHINDU' }, anon)).status, 404);
  const open = await req('POST', '/api/ref/open', { token, department: 'soh', surname: 'muchindu' }, anon);
  assert.equal(open.status, 200);
  assert.equal(open.body.items.length, 1);
  assert.deepEqual(Object.keys(open.body.items[0]).sort(), ['created_at', 'description', 'id', 'number', 'resolution_note', 'resolved_at']);

  const done = await req('POST', '/api/ref/resolve', { token, department: 'SOH', surname: 'MUCHINDU', referralId: open.body.items[0].id, note: 'Sorted at Accounts.' }, anon);
  assert.equal(done.status, 200);
  assert.equal((await db.get('SELECT status FROM tickets WHERE id = ?', t.id)).status, 'Resolved');
  const ev = await db.get("SELECT actor FROM ticket_events WHERE ticket_id = ? AND to_status = 'Resolved'", t.id);
  assert.match(ev.actor, /^Temporal user/);
});

test('requester can rate and reopen within 7 days', async () => {
  const creds = { number: 'A01', requesterNo: 'STU1001' };
  assert.equal((await req('POST', '/api/track/rate', { ...creds, rating: 5 }, { auth: false })).status, 200);
  assert.equal((await req('POST', '/api/track/reopen', { ...creds, reason: 'It broke again.' }, { auth: false })).status, 200);
  assert.equal((await db.get("SELECT status FROM tickets WHERE number = 'A01'")).status, 'New');
});

test('escalation: reminder at 2 and admin alert at 3 working days', async () => {
  const { ticket } = await T.createTicket(bulk('old'));
  const { id: itUser } = await db.get("SELECT id FROM users WHERE username = 'IT-CU411'");
  const mon = Date.UTC(2026, 10, 2, 8); // Monday 10:00 Lusaka
  await db.run('UPDATE tickets SET opened_at = ?, assigned_to = ? WHERE id = ?', mon, itUser, ticket.id);

  await jobs.runEscalation(Date.UTC(2026, 10, 3, 8)); // Tue: 1 day
  let t = await db.get('SELECT * FROM tickets WHERE id = ?', ticket.id);
  assert.equal(t.reminded_at, null);
  await jobs.runEscalation(Date.UTC(2026, 10, 4, 8)); // Wed: 2 days -> reminder
  t = await db.get('SELECT * FROM tickets WHERE id = ?', ticket.id);
  assert.ok(t.reminded_at);
  assert.equal(t.escalated_at, null);
  await jobs.runEscalation(Date.UTC(2026, 10, 5, 8)); // Thu: 3 days -> escalate
  t = await db.get('SELECT * FROM tickets WHERE id = ?', ticket.id);
  assert.equal(t.status, 'Needs Escalation');
  const msg = await db.get('SELECT message FROM notifications WHERE message LIKE ? ORDER BY id DESC', `Ticket ${t.number} %`);
  assert.equal(msg.message, `Ticket ${t.number} assigned to IT-CU411 has been unresolved for 3+ working days.`);
});

test('cron endpoint requires the secret', async () => {
  assert.equal((await req('GET', '/api/cron', null, { auth: false })).status, 401);
  assert.equal((await req('GET', '/api/cron', null, { auth: false, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await req('GET', '/api/cron', null, { auth: false, headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.runEscalation, 'ok');
});

test('admin login requires 2FA enrolment', async () => {
  cookie = '';
  const first = await req('POST', '/api/login', { username: 'IT-ADM01', password: 'admin-password-1' });
  assert.ok(first.body.totpSetup.secret);
  assert.equal(cookie, '');
  const code = L.totp(first.body.totpSetup.secret);
  const ok = await req('POST', '/api/login', { username: 'IT-ADM01', password: 'admin-password-1', code });
  assert.equal(ok.body.ok, true);
  assert.equal((await req('GET', '/api/users')).status, 200);
  const rep = await req('GET', '/api/reports');
  assert.equal(rep.status, 200);
  assert.ok(rep.body.summary.total > 0);
  const csv = await fetch(`${base}/api/reports/export.csv`, { headers: { Cookie: cookie } });
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM so Excel shows accents correctly
  assert.match(bytes.subarray(3).toString(), /^number,created,status/);
});

test('production refuses to start without required secrets', () => {
  const { missing } = checkConfig({ VERCEL: '1' });
  assert.deepEqual(missing.map((m) => m.split(' ')[0]), ['DATABASE_URL', 'APP_SECRET', 'BASE_URL', 'CRON_SECRET']);
  const ok = checkConfig({ DATABASE_URL: 'postgres://x', APP_SECRET: 'a'.repeat(64), BASE_URL: 'https://x', CRON_SECRET: 'b'.repeat(32) });
  assert.deepEqual(ok.missing, []);
});
