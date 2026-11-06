'use strict';
// Routes for signed-in IT users and SUDO admins.
const express = require('express');
const { db, getSetting, setSetting, audit, logEvent } = require('./db');
const L = require('./lib');
const { rateLimit, createSession, destroySession, requireRole } = require('./security');
const storage = require('./storage');
const T = require('./tickets');
const notify = require('./notify');

const r = express.Router();
r.use('/api', express.json({ limit: '100kb' }), (req, res, next) => { req.body ??= {}; next(); });
const it = requireRole('it', 'admin');
const admin = requireRole('admin');
const bad = (res, error) => res.status(400).json({ error });
const toInt = (v) => parseInt(v, 10) || 0;
const DUMMY_HASH = L.hashPassword('dummy-password-for-timing');
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Auth ----------
r.post('/api/login', rateLimit('login-ip', 50, 15 * 60000),
  rateLimit('login-user', 5, 15 * 60000, (req) => String(req.body.username || '').toUpperCase() || null), async (req, res) => {
    const username = L.clean(req.body.username, 30).toUpperCase();
    const u = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', username);
    const pwOk = L.verifyPassword(String(req.body.password || ''), u ? u.pw_hash : DUMMY_HASH);
    if (!u || !pwOk) {
      await audit(username || '?', 'login.failed', '', req.ip);
      return res.status(401).json({ error: 'Incorrect IT ID or password.' });
    }
    if (u.role === 'admin') {
      const code = String(req.body.code || '');
      if (u.totp_secret) {
        if (!code) return res.json({ need2fa: true });
        if (!L.verifyTotp(u.totp_secret, code)) { await audit(username, 'login.2fa_failed', '', req.ip); return res.status(401).json({ error: 'Wrong authentication code.', need2fa: true }); }
      } else {
        // First admin sign-in: enrol an authenticator app before access is granted.
        if (!code || !u.totp_pending) {
          const secret = L.newTotpSecret();
          await db.run('UPDATE users SET totp_pending = ? WHERE id = ?', secret, u.id);
          return res.json({ totpSetup: { secret, otpauth: `otpauth://totp/IT%20Helpdesk:${username}?secret=${secret}&issuer=IT%20Helpdesk` } });
        }
        if (!L.verifyTotp(u.totp_pending, code)) return res.status(401).json({ error: 'Wrong authentication code.', need2fa: true });
        await db.run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?', u.id);
        await audit(username, '2fa.enrolled', '', req.ip);
      }
    }
    await createSession(res, u.id);
    await audit(username, 'login.ok', '', req.ip);
    res.json({ ok: true, mustChangePassword: !!u.must_change_pw });
  });

r.post('/api/logout', async (req, res) => { await destroySession(req, res); res.json({ ok: true }); });

r.get('/api/me', it, async (req, res) => {
  const u = req.user;
  res.json({
    user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role, mustChangePassword: !!u.must_change_pw },
    statuses: T.STATUSES, priorities: T.PRIORITIES, categories: await getSetting('categories'),
    slaHours: await getSetting('slaHours'), cannedReplies: await getSetting('cannedReplies'),
    departments: await db.all('SELECT code, name FROM departments WHERE active = 1 ORDER BY code'),
    staff: await db.all('SELECT id, username, full_name FROM users WHERE active = 1 ORDER BY username'),
  });
});

r.post('/api/me/password', it, async (req, res) => {
  const next = String(req.body.next || '');
  if (!L.verifyPassword(String(req.body.current || ''), req.user.pw_hash)) return bad(res, 'Current password is wrong.');
  if (next.length < 10) return bad(res, 'Use at least 10 characters.');
  if (next === String(req.body.current)) return bad(res, 'Choose a password different from the current one.');
  await db.run('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?', L.hashPassword(next), req.user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', req.user.id, req.user.id_hash);
  await audit(req.user.username, 'password.changed', '', req.ip);
  res.json({ ok: true });
});

// ---------- Tickets ----------
function ticketFilters(q, user) {
  for (const k of ['from', 'to']) if (q[k] && !YMD.test(q[k])) throw new Error('Bad date');
  const where = [];
  const args = [];
  if (q.from) { where.push('t.created_at >= ?'); args.push(L.startOfLocalDay(q.from)); }
  if (q.to) { where.push('t.created_at <= ?'); args.push(L.endOfLocalDay(q.to)); }
  if (q.status) { where.push('t.status = ?'); args.push(String(q.status)); }
  if (q.category) { where.push('t.category = ?'); args.push(String(q.category)); }
  if (q.priority) { where.push('t.priority = ?'); args.push(String(q.priority)); }
  if (q.department) { where.push('EXISTS (SELECT 1 FROM referrals rf JOIN referral_links l ON l.id = rf.link_id WHERE rf.ticket_id = t.id AND l.department = ?)'); args.push(String(q.department)); }
  if (q.assignee === 'me') { where.push('t.assigned_to = ?'); args.push(user.id); }
  else if (q.assignee === 'none') where.push('t.assigned_to IS NULL');
  else if (q.assignee) { where.push('t.assigned_to = ?'); args.push(toInt(q.assignee)); }
  if (q.q) {
    const s = L.clean(q.q, 100);
    where.push('(t.number = ? OR t.issue ILIKE ? OR t.requester_no = ?)');
    args.push(s.toUpperCase(), `%${s}%`, s.toUpperCase());
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

r.get('/api/tickets', it, async (req, res) => {
  let f;
  try { f = ticketFilters(req.query, req.user); } catch { return bad(res, 'Invalid filter.'); }
  res.json(await db.all(`SELECT t.id, t.number, t.status, t.priority, t.category, t.location, t.tracked, t.widespread,
    t.duplicate_of, t.created_at, t.resolved_at, t.assigned_to, u.username AS assignee, substr(t.issue, 1, 140) AS summary
    FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to ${f.sql} ORDER BY t.created_at DESC LIMIT 500`, ...f.args));
});

const getTicket = (id) => db.get('SELECT * FROM tickets WHERE id = ?', String(id));

r.get('/api/tickets/:id', it, async (req, res) => {
  const t = await getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  t.events = await db.all('SELECT at, actor, type, from_status, to_status, note, is_public AS "public" FROM ticket_events WHERE ticket_id = ? ORDER BY at, id', t.id);
  t.referrals = await db.all(`SELECT r.id, r.description, r.created_at, r.resolved_at, r.resolution_note, l.id AS link_id, l.department, l.surname, l.expires_ymd
    FROM referrals r JOIN referral_links l ON l.id = r.link_id WHERE r.ticket_id = ? ORDER BY r.created_at`, t.id);
  t.attachment = (await db.get('SELECT id, name, mime, size FROM attachments WHERE ticket_id = ?', t.id)) || null;
  await audit(req.user.username, 'ticket.viewed', t.number, req.ip);
  res.json(t);
});

r.get('/api/tickets/:id/attachment', it, async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE ticket_id = ?', String(req.params.id));
  if (!a) return res.status(404).end();
  const data = await storage.get(a.storage_key);
  await audit(req.user.username, 'attachment.downloaded', a.name, req.ip);
  res.set({ 'Content-Type': a.mime, 'Content-Disposition': `attachment; filename="${a.name}"` });
  res.send(data);
});

r.patch('/api/tickets/:id', it, async (req, res) => {
  const t = await getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  const b = req.body;
  const note = L.clean(b.note, 2000) || null;
  if (b.priority && b.priority !== t.priority) {
    if (!T.PRIORITIES.includes(b.priority)) return bad(res, 'Bad priority.');
    await db.run('UPDATE tickets SET priority = ? WHERE id = ?', b.priority, t.id);
    await logEvent(t.id, req.user.username, 'note', { note: `Priority ${t.priority} -> ${b.priority}` });
  }
  if (b.category && b.category !== t.category && (await getSetting('categories')).includes(b.category)) {
    await db.run('UPDATE tickets SET category = ? WHERE id = ?', b.category, t.id);
    await logEvent(t.id, req.user.username, 'note', { note: `Category ${t.category} -> ${b.category}` });
  }
  if (b.assignedTo !== undefined && toInt(b.assignedTo) !== (t.assigned_to || 0)) {
    const to = b.assignedTo ? await db.get('SELECT id, username FROM users WHERE id = ? AND active = 1', toInt(b.assignedTo)) : null;
    if (b.assignedTo && !to) return bad(res, 'Unknown user.');
    await db.run('UPDATE tickets SET assigned_to = ?, reminded_at = NULL WHERE id = ?', to ? to.id : null, t.id);
    await logEvent(t.id, req.user.username, 'assign', { note: `Assigned to ${to ? to.username : 'nobody'}` });
    await audit(req.user.username, 'ticket.assigned', `${t.number} -> ${to ? to.username : 'none'}`, req.ip);
    if (to && to.id !== req.user.id) notify.later(notify.staff(to.id, `Ticket ${t.number} was assigned to you by ${req.user.username}.`, t.id));
  }
  if (b.status && b.status !== t.status) {
    if (!T.STATUSES.includes(b.status) || b.status === 'Referred to Department') return bad(res, 'Use "Refer to department" to refer a ticket.');
    await T.changeStatus(t, b.status, req.user.username, note, !!b.public);
  } else if (note) {
    await logEvent(t.id, req.user.username, 'note', { note, pub: b.public });
    if (b.public) notify.later(notify.requester(t, `Update on ticket ${t.number}: ${note}`));
  }
  res.json({ ok: true });
});

r.post('/api/tickets/:id/claim', it, async (req, res) => {
  const t = await getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  await db.run('UPDATE tickets SET assigned_to = ?, reminded_at = NULL WHERE id = ?', req.user.id, t.id);
  await logEvent(t.id, req.user.username, 'assign', { note: `Claimed by ${req.user.username}` });
  if (t.status === 'New') await T.changeStatus(t, 'In Progress', req.user.username, null, true);
  res.json({ ok: true });
});

r.post('/api/tickets/:id/refer', it, async (req, res) => {
  const t = await getTicket(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  const department = L.clean(req.body.department, 20).toUpperCase();
  const surname = L.clean(req.body.surname, 40).toUpperCase();
  const description = L.clean(req.body.description, 1000);
  if (!L.RX.surname.test(surname)) return bad(res, 'Enter the recipient surname (letters only).');
  if (!description) return bad(res, 'Describe the issue for the department.');
  try { res.json(await T.referTicket(t, { department, surname, description }, req.user)); } catch (e) { bad(res, e.message); }
});

// ---------- Referral links ----------
r.get('/api/links', it, async (req, res) => {
  res.json(await db.all(`SELECT l.id, l.department, l.surname, l.created_at, l.expires_ymd, l.expires_at, l.revoked_at, l.failed_attempts,
    u.username AS created_by, COUNT(r.id) AS total, COUNT(r.resolved_at) AS resolved
    FROM referral_links l LEFT JOIN users u ON u.id = l.created_by LEFT JOIN referrals r ON r.link_id = l.id
    GROUP BY l.id, u.username ORDER BY l.id DESC LIMIT 200`));
});
const getLink = (id) => db.get('SELECT * FROM referral_links WHERE id = ?', toInt(id));

r.post('/api/links/:id/resend', it, async (req, res) => {
  const l = await getLink(req.params.id);
  if (!l || l.revoked_at) return bad(res, 'Link not found or revoked.');
  res.json({ url: await T.resendLink(l, req.user) });
});
r.post('/api/links/:id/extend', it, async (req, res) => {
  const l = await getLink(req.params.id);
  const days = toInt(req.body.days);
  const reason = L.clean(req.body.reason, 300);
  if (!l || l.revoked_at) return bad(res, 'Link not found or revoked.');
  if (!(days >= 1 && days <= 10)) return bad(res, 'Extend by 1 to 10 working days.');
  if (!reason) return bad(res, 'A reason is required.');
  res.json({ expires: await T.extendLink(l, days, reason, req.user) });
});
r.post('/api/links/:id/revoke', it, async (req, res) => {
  const l = await getLink(req.params.id);
  if (!l) return bad(res, 'Link not found.');
  await db.run('UPDATE referral_links SET revoked_at = ? WHERE id = ?', Date.now(), l.id);
  await audit(req.user.username, 'referral.revoked', `link ${l.id}`, req.ip);
  res.json({ ok: true });
});

// ---------- Dashboard numbers ----------
r.get('/api/stats/today', it, async (req, res) => {
  const start = L.startOfLocalDay(L.localYmd());
  res.json(await db.get(`SELECT
    COUNT(*) FILTER (WHERE created_at >= ?) AS received,
    COUNT(*) FILTER (WHERE status = 'Resolved' AND resolved_at >= ?) AS completed,
    COUNT(*) FILTER (WHERE status IN ('New','In Progress','Pending')) AS pending,
    COUNT(*) FILTER (WHERE status = 'Needs Escalation') AS escalation,
    COUNT(*) FILTER (WHERE status = 'Referred to Department') AS referred
    FROM tickets`, start, start));
});

r.get('/api/stats/me', it, async (req, res) => {
  res.json(await db.get(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status = 'Resolved') resolved,
    COUNT(*) FILTER (WHERE status != 'Resolved') open,
    AVG(CASE WHEN status = 'Resolved' THEN (resolved_at - created_at) / 3600000.0 END) avg_hours
    FROM tickets WHERE assigned_to = ?`, req.user.id));
});

r.get('/api/notifications', it, async (req, res) => {
  const items = await db.all('SELECT id, message, ticket_id, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', req.user.id);
  const { c: unread } = await db.get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id);
  res.json({ items, unread });
});
r.post('/api/notifications/read', it, async (req, res) => {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), req.user.id);
  res.json({ ok: true });
});

// ---------- Reports (admin) ----------
const LOCAL_DAY = "to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'Africa/Lusaka', 'YYYY-MM-DD')";
const localTime = (col) => `to_char(to_timestamp(${col} / 1000.0) AT TIME ZONE 'Africa/Lusaka', 'YYYY-MM-DD HH24:MI')`;
function reportRange(q) {
  const to = YMD.test(q.to || '') ? q.to : L.localYmd();
  const from = YMD.test(q.from || '') ? q.from : L.localYmd(Date.now() - 29 * 86400000);
  return { from, to, a: L.startOfLocalDay(from), b: L.endOfLocalDay(to) };
}
r.get('/api/reports', admin, async (req, res) => {
  const { from, to, a, b } = reportRange(req.query);
  const all = (sql) => db.all(sql, a, b);
  res.json({
    from, to,
    perDay: await all(`SELECT ${LOCAL_DAY} AS day, COUNT(*) n FROM tickets WHERE created_at BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`),
    byCategory: await all('SELECT category k, COUNT(*) n FROM tickets WHERE created_at BETWEEN ? AND ? GROUP BY category ORDER BY n DESC'),
    byStatus: await all('SELECT status k, COUNT(*) n FROM tickets WHERE created_at BETWEEN ? AND ? GROUP BY status ORDER BY n DESC'),
    byLocation: await all("SELECT COALESCE(location, '(none)') k, COUNT(*) n FROM tickets WHERE created_at BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC"),
    referrals: await all('SELECT l.department k, COUNT(*) n, COUNT(r.resolved_at) resolved FROM referrals r JOIN referral_links l ON l.id = r.link_id WHERE r.created_at BETWEEN ? AND ? GROUP BY l.department'),
    byStaff: await all(`SELECT COALESCE(u.username, '(unassigned)') k, COUNT(*) n, COUNT(*) FILTER (WHERE t.status = 'Resolved') resolved,
      ROUND(AVG(CASE WHEN t.status = 'Resolved' THEN (t.resolved_at - t.created_at) / 3600000.0 END), 1) avg_hours
      FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.created_at BETWEEN ? AND ? GROUP BY 1 ORDER BY n DESC`),
    summary: await db.get(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE status = 'Resolved') resolved,
      ROUND(AVG(CASE WHEN status = 'Resolved' THEN (resolved_at - created_at) / 3600000.0 END), 1) avg_hours,
      ROUND(AVG(rating), 2) avg_rating, COUNT(*) FILTER (WHERE tracked = 0) untracked FROM tickets WHERE created_at BETWEEN ? AND ?`, a, b),
  });
});

// CSV opens directly in Excel. Cells starting with = + - @ are prefixed to block formula injection.
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
r.get('/api/reports/export.csv', admin, async (req, res) => {
  const { from, to, a, b } = reportRange(req.query);
  const rows = await db.all(`SELECT t.number, ${localTime('t.created_at')} created, t.status, t.priority, t.category,
    t.location, u.username assignee, ${localTime('t.resolved_at')} resolved, t.rating,
    CASE t.tracked WHEN 1 THEN 'Tracked' ELSE 'Untracked' END tracking
    FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.created_at BETWEEN ? AND ? ORDER BY t.created_at`, a, b);
  const head = ['number', 'created', 'status', 'priority', 'category', 'location', 'assignee', 'resolved', 'rating', 'tracking'];
  const csv = [head.join(','), ...rows.map((row) => head.map((h) => csvCell(row[h])).join(','))].join('\r\n');
  await audit(req.user.username, 'report.exported', `${from}..${to}`, req.ip);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tickets-${from}-to-${to}.csv"` });
  res.send('﻿' + csv);
});

// ---------- Admin: users ----------
r.get('/api/users', admin, async (req, res) => {
  res.json(await db.all('SELECT id, username, full_name, email, role, active, (totp_secret IS NOT NULL) AS has2fa, created_at FROM users ORDER BY username'));
});
r.post('/api/users', admin, async (req, res) => {
  const staffId = L.clean(req.body.staffId, 20).toUpperCase().replace(/^IT-/, '');
  const username = `IT-${staffId}`;
  const fullName = L.clean(req.body.fullName, 80);
  const email = L.clean(req.body.email, 120).toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'it';
  if (!L.RX.username.test(username)) return bad(res, 'Staff ID must be 2–20 letters or digits, e.g. CU411.');
  if (!fullName || !L.RX.email.test(email)) return bad(res, 'Name and a valid email are required.');
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) return bad(res, `${username} already exists.`);
  const password = L.randomPassword();
  await db.run('INSERT INTO users(username, full_name, email, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    username, fullName, email, role, L.hashPassword(password), Date.now());
  await audit(req.user.username, 'user.created', `${username} (${role})`, req.ip);
  res.json({ username, password }); // shown once to the admin; user must change it at first sign-in
});
r.patch('/api/users/:id', admin, async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', toInt(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found.' });
  const out = { ok: true };
  if (req.body.active !== undefined) {
    if (u.id === req.user.id) return bad(res, 'You cannot deactivate yourself.');
    await db.run('UPDATE users SET active = ? WHERE id = ?', req.body.active ? 1 : 0, u.id);
    if (!req.body.active) await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }
  if (req.body.role && ['it', 'admin'].includes(req.body.role) && u.id !== req.user.id) await db.run('UPDATE users SET role = ? WHERE id = ?', req.body.role, u.id);
  if (req.body.resetPassword) {
    out.password = L.randomPassword();
    await db.run('UPDATE users SET pw_hash = ?, must_change_pw = 1 WHERE id = ?', L.hashPassword(out.password), u.id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }
  if (req.body.reset2fa) await db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?', u.id);
  await audit(req.user.username, 'user.updated', `${u.username}: ${Object.keys(req.body).join(',')}`, req.ip);
  res.json(out);
});

// ---------- Admin: settings, departments, knowledge base, audit ----------
const SETTING_RULES = {
  holidays: (v) => Array.isArray(v) && v.every((d) => YMD.test(d)),
  categories: (v) => Array.isArray(v) && v.length && v.every((c) => typeof c === 'string' && c.length <= 40) && v.includes('Other'),
  cannedReplies: (v) => Array.isArray(v) && v.every((c) => typeof c === 'string' && c.length <= 500),
  reminderWorkingDays: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  escalationWorkingDays: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  linkWorkingDays: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  widespreadThreshold: (v) => Number.isInteger(v) && v >= 2 && v <= 100,
  retentionDays: (v) => Number.isInteger(v) && v >= 30,
  slaHours: (v) => v && T.PRIORITIES.every((p) => Number(v[p]) > 0),
};
r.get('/api/settings', admin, async (req, res) => {
  const s = {};
  for (const k of Object.keys(SETTING_RULES)) s[k] = await getSetting(k);
  s.departments = await db.all('SELECT code, name, email, active FROM departments ORDER BY code');
  res.json(s);
});
r.put('/api/settings', admin, async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (k === 'departments') continue;
    if (!SETTING_RULES[k] || !SETTING_RULES[k](v)) return bad(res, `Invalid value for ${k}.`);
  }
  const depts = Array.isArray(req.body.departments) ? req.body.departments.map((d) => ({
    code: L.clean(d.code, 20).toUpperCase(), name: L.clean(d.name, 80), email: L.clean(d.email, 120), active: d.active !== false,
  })) : [];
  for (const d of depts) if (!/^[A-Z0-9]{2,20}$/.test(d.code) || !L.RX.email.test(d.email)) return bad(res, `Invalid department ${d.code || ''}.`);
  for (const [k, v] of Object.entries(req.body)) if (SETTING_RULES[k]) await setSetting(k, v);
  for (const d of depts) {
    await db.run(`INSERT INTO departments(code, name, email, active) VALUES (?, ?, ?, ?)
      ON CONFLICT (code) DO UPDATE SET name = excluded.name, email = excluded.email, active = excluded.active`,
    d.code, d.name || d.code, d.email, d.active ? 1 : 0);
  }
  await audit(req.user.username, 'settings.updated', Object.keys(req.body).join(','), req.ip);
  res.json({ ok: true });
});

r.post('/api/kb', admin, async (req, res) => {
  const title = L.clean(req.body.title, 120), body = L.clean(req.body.body, 4000);
  if (!title || !body) return bad(res, 'Title and text are required.');
  if (req.body.id) await db.run('UPDATE kb_articles SET title = ?, body = ?, updated_at = ? WHERE id = ?', title, body, Date.now(), toInt(req.body.id));
  else await db.run('INSERT INTO kb_articles(title, body, updated_at) VALUES (?, ?, ?)', title, body, Date.now());
  await audit(req.user.username, 'kb.saved', title, req.ip);
  res.json({ ok: true });
});
r.delete('/api/kb/:id', admin, async (req, res) => {
  await db.run('DELETE FROM kb_articles WHERE id = ?', toInt(req.params.id));
  await audit(req.user.username, 'kb.deleted', req.params.id, req.ip);
  res.json({ ok: true });
});

r.get('/api/audit', admin, async (req, res) => {
  res.json(await db.all('SELECT at, actor, action, details, ip FROM audit_log ORDER BY id DESC LIMIT 300'));
});

module.exports = r;
