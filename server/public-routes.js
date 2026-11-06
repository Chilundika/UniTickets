'use strict';
// Routes with no login: intake, tracking, knowledge base, and the Temporal-user referral page.
const express = require('express');
const { db, getSetting, audit, logEvent } = require('./db');
const { clean, RX, normalisePhone, sentenceCount, sha256 } = require('./lib');
const { rateLimit, newCaptcha, checkCaptcha } = require('./security');
const { TURNSTILE_SITE_KEY } = require('./config');
const storage = require('./storage');
const T = require('./tickets');
const notify = require('./notify');

const r = express.Router();
const small = express.json({ limit: '20kb' });
const bad = (res, error, field) => res.status(400).json({ error, field });
const MIN = 60000;

r.get('/api/time', (req, res) => res.json({ now: Date.now(), tz: 'Africa/Lusaka' }));

r.get('/api/public-config', async (req, res) => {
  res.json({ categories: await getSetting('categories'), turnstileSiteKey: TURNSTILE_SITE_KEY || null, uploads: storage.enabled });
});

// Many students share one campus IP address, so per-IP limits here are deliberately generous.
r.get('/api/captcha', rateLimit('captcha', 300, 10 * MIN), (req, res) => res.json(newCaptcha()));

r.get('/api/kb', rateLimit('kb', 600, 10 * MIN), async (req, res) => {
  const q = clean(req.query.q, 60);
  const rows = q
    ? await db.all('SELECT id, title, body FROM kb_articles WHERE title ILIKE ? OR body ILIKE ? ORDER BY title LIMIT 5', `%${q}%`, `%${q}%`)
    : await db.all('SELECT id, title, body FROM kb_articles ORDER BY title LIMIT 20');
  res.json(rows);
});

// ---------- Create ticket ----------
const ALLOWED = { 'image/png': [0x89, 0x50], 'image/jpeg': [0xff, 0xd8], 'application/pdf': [0x25, 0x50] };
const MAX_FILE = 2 * 1024 * 1024;
const requesterKey = (req) => clean(req.body?.requesterNo, 20).toUpperCase() || null;

r.post('/api/tickets',
  express.json({ limit: '3mb' }),
  rateLimit('intake-ip', 60, 10 * MIN),
  rateLimit('intake-requester', 3, 10 * MIN, requesterKey), // 3 tickets per student number per 10 minutes
  async (req, res) => {
    const b = req.body || {};
    if (b.website) return bad(res, 'Submission rejected.'); // honeypot field, hidden from people
    if (!(await checkCaptcha(b, req.ip))) return bad(res, 'The security check failed or expired. Please try again.', 'captcha');

    const consent = b.consent === 'yes' ? true : b.consent === 'no' ? false : null;
    if (consent === null) return bad(res, 'Please choose YES or NO for consent.', 'consent');

    const requesterNo = clean(b.requesterNo, 20).toUpperCase();
    const email = clean(b.email, 120).toLowerCase();
    const phone = normalisePhone(b.phone);
    if (!RX.requesterNo.test(requesterNo)) return bad(res, 'Enter a valid student/staff number.', 'requesterNo');
    if (!RX.email.test(email)) return bad(res, 'Enter a valid email address.', 'email');
    if (!RX.phone.test(phone)) return bad(res, 'Enter the number in international format, e.g. +260971234567.', 'phone');

    let reason = null;
    if (!consent) {
      reason = clean(b.reason, 300);
      if (!reason) return bad(res, 'Please give a reason.', 'reason');
      if (sentenceCount(reason) > 3) return bad(res, 'Please keep the reason to 1–3 sentences.', 'reason');
    }

    const issue = clean(b.issue, 10000);
    if (!issue) return bad(res, 'Please describe your issue.', 'issue');
    const categories = await getSetting('categories');
    const category = categories.includes(b.category) ? b.category : 'Other';

    let attachment = null;
    if (b.attachment && b.attachment.data) {
      if (!storage.enabled) return bad(res, 'File uploads are switched off.', 'attachment');
      const mime = String(b.attachment.mime);
      const data = Buffer.from(String(b.attachment.data), 'base64');
      const magic = ALLOWED[mime];
      if (!magic || data[0] !== magic[0] || data[1] !== magic[1]) return bad(res, 'Only PNG, JPG or PDF files are allowed.', 'attachment');
      if (data.length > MAX_FILE) return bad(res, 'The file must be 2 MB or smaller.', 'attachment');
      attachment = { name: clean(b.attachment.name, 100).replace(/[^\w.\- ]/g, '_') || 'file', mime, data };
    }

    // No consent: the ticket is still created, but no personal details are kept.
    const { ticket: t, notifications } = await T.createTicket({
      consent, reason, issue, category, attachment,
      requesterNo: consent ? requesterNo : null,
      email: consent ? email : null,
      phone: consent ? phone : null,
      location: clean(b.location, 60) || null,
    });
    notify.later(notifications);
    await audit('requester', 'ticket.created', `${t.number}${consent ? '' : ' (untracked)'}`, req.ip);
    res.json({ number: t.number, tracked: !!t.tracked });
  });

// ---------- Tracking (consent = YES only) ----------
const findTracked = (number, requesterNo) => db.get(`SELECT * FROM tickets WHERE number = ? AND requester_no = ?
  AND tracked = 1 ORDER BY created_at DESC LIMIT 1`, clean(number, 8).toUpperCase(), clean(requesterNo, 20).toUpperCase());
const NOT_FOUND = 'No tracked ticket matches that ticket number and student/staff number.';
// Per IP (generous for shared Wi-Fi) and per ticket number (stops guessing the student number for one ticket).
const trackLimits = [small, rateLimit('track-ip', 100, 10 * MIN),
  rateLimit('track-number', 10, 10 * MIN, (req) => clean(req.body?.number, 8).toUpperCase() || null)];

r.post('/api/track', ...trackLimits, async (req, res) => {
  const t = await findTracked(req.body.number, req.body.requesterNo);
  if (!t) return res.status(404).json({ error: NOT_FOUND });
  const events = (await db.all(`SELECT at, type, to_status, note FROM ticket_events WHERE ticket_id = ?
    AND (type IN ('created','status') OR is_public = 1) ORDER BY at, id`, t.id))
    .map((e) => ({ at: e.at, text: e.type === 'note' ? e.note : `Status: ${e.to_status}${e.note && e.type === 'status' ? ' – ' + e.note : ''}` }));
  const resolvedRecently = t.status === 'Resolved' && t.resolved_at > Date.now() - 7 * 86400000;
  res.json({
    number: t.number, status: t.status, category: t.category, createdAt: t.created_at, resolvedAt: t.resolved_at,
    events, canRate: t.status === 'Resolved' && !t.rating, canReopen: resolvedRecently, rating: t.rating,
  });
});

r.post('/api/track/rate', ...trackLimits, async (req, res) => {
  const t = await findTracked(req.body.number, req.body.requesterNo);
  const rating = parseInt(req.body.rating, 10);
  if (!t) return res.status(404).json({ error: NOT_FOUND });
  if (t.status !== 'Resolved' || t.rating) return bad(res, 'This ticket cannot be rated now.');
  if (!(rating >= 1 && rating <= 5)) return bad(res, 'Choose 1 to 5 stars.', 'rating');
  await db.run('UPDATE tickets SET rating = ?, rating_comment = ? WHERE id = ?', rating, clean(req.body.comment, 500) || null, t.id);
  await audit('requester', 'ticket.rated', `${t.number}: ${rating}`, req.ip);
  res.json({ ok: true });
});

r.post('/api/track/reopen', ...trackLimits, async (req, res) => {
  const t = await findTracked(req.body.number, req.body.requesterNo);
  if (!t) return res.status(404).json({ error: NOT_FOUND });
  if (!(t.status === 'Resolved' && t.resolved_at > Date.now() - 7 * 86400000)) return bad(res, 'Tickets can only be reopened within 7 days of being resolved.');
  const reason = clean(req.body.reason, 500);
  if (!reason) return bad(res, 'Please say what happened.', 'reason');
  await db.run(`UPDATE tickets SET status = 'New', resolved_at = NULL, opened_at = ?, reminded_at = NULL, escalated_at = NULL,
    reopen_count = reopen_count + 1, rating = NULL, rating_comment = NULL WHERE id = ?`, Date.now(), t.id);
  await logEvent(t.id, 'requester', 'status', { from: 'Resolved', to: 'New', note: `Reopened: ${reason}`, pub: 1 });
  await audit('requester', 'ticket.reopened', t.number, req.ip);
  if (t.assigned_to) notify.later(notify.staff(t.assigned_to, `Ticket ${t.number} was reopened by the requester: ${reason}`, t.id));
  res.json({ ok: true });
});

// ---------- Temporal user (department referral link) ----------
// Requires the secret token (from the email link) AND the matching department + surname.
// 5 wrong confirmations lock the link; IT can resend it to unlock.
async function openLink(req, res) {
  const { token, department, surname } = req.body || {};
  const link = token && await db.get('SELECT * FROM referral_links WHERE token_hash = ?', sha256(String(token)));
  if (!link || link.revoked_at) { res.status(404).json({ error: 'This link is not valid. Please ask the IT Helpdesk to resend it.' }); return null; }
  if (link.expires_at < Date.now()) { res.status(410).json({ error: 'This link has expired. Please ask the IT Helpdesk to resend or extend it.' }); return null; }
  if (link.failed_attempts >= 5) { res.status(423).json({ error: 'This link is locked after too many wrong attempts. Please ask the IT Helpdesk to resend it.' }); return null; }
  const ok = clean(department, 20).toUpperCase() === link.department && clean(surname, 40).toUpperCase() === link.surname;
  if (!ok) {
    await db.run('UPDATE referral_links SET failed_attempts = failed_attempts + 1 WHERE id = ?', link.id);
    await audit('Temporal user', 'referral.open_failed', `link ${link.id}`, req.ip);
    res.status(401).json({ error: 'Department or surname does not match this link.' });
    return null;
  }
  return link;
}
const refLimits = [small, rateLimit('ref', 100, 10 * MIN)];

r.post('/api/ref/open', ...refLimits, async (req, res) => {
  const link = await openLink(req, res);
  if (!link) return;
  // Only the ticket number and IT's description: no requester personal data.
  const items = await db.all(`SELECT r.id, t.number, r.description, r.created_at, r.resolved_at, r.resolution_note
    FROM referrals r JOIN tickets t ON t.id = r.ticket_id WHERE r.link_id = ? ORDER BY r.created_at`, link.id);
  res.json({ department: link.department, surname: link.surname, expires: link.expires_ymd, items, user: 'Temporal user' });
});

r.post('/api/ref/resolve', ...refLimits, async (req, res) => {
  const link = await openLink(req, res);
  if (!link) return;
  const ok = await T.resolveReferral(link, parseInt(req.body.referralId, 10) || 0, clean(req.body.note, 500) || null);
  if (!ok) return bad(res, 'That issue is already resolved or does not belong to this link.');
  res.json({ ok: true });
});

module.exports = r;
