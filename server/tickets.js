'use strict';
// Ticket and referral business logic shared by the public and staff routes.
const { db, tx, getSetting, setSetting, nextTicketNumber, audit, logEvent } = require('./db');
const { localYmd, nextYmd, nthWorkingDay, endOfLocalDay, newToken, sha256, uuid } = require('./lib');
const { BASE_URL } = require('./config');
const { hit } = require('./security');
const storage = require('./storage');
const notify = require('./notify');

const STATUSES = ['New', 'In Progress', 'Pending', 'Needs Escalation', 'Referred to Department', 'Resolved'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

// Round-robin over active IT users (admins are not auto-assigned).
async function roundRobin(t) {
  const users = await t.all("SELECT id FROM users WHERE active = 1 AND role = 'it' ORDER BY id");
  if (!users.length) return null;
  const last = (await getSetting('lastAssigned', t)) || 0;
  const next = users.find((u) => u.id > last) || users[0];
  await setSetting('lastAssigned', next.id, t);
  return next.id;
}

// Returns the ticket plus a promise for the notifications (callers pass it to notify.later).
async function createTicket(d) {
  const now = Date.now();
  // The file goes to storage first, so a slow upload never holds the ticket-number lock.
  let attachmentKey = null;
  if (d.attachment) {
    attachmentKey = `attachments/${localYmd(now)}/${uuid()}`;
    await storage.put(attachmentKey, d.attachment.data, d.attachment.mime);
  }
  const t = await tx(async (c) => {
    const { id, seq, number } = await nextTicketNumber(c);
    const dup = d.requesterNo && await c.get(`SELECT number FROM tickets WHERE requester_no = ? AND status != 'Resolved'
      AND created_at > ? ORDER BY created_at DESC LIMIT 1`, d.requesterNo, now - 7 * 86400000);
    const assigned = await roundRobin(c);
    await c.run(`INSERT INTO tickets(id, seq, number, requester_no, email, phone, consent, consent_reason, consent_at, tracked,
      category, issue, location, assigned_to, duplicate_of, created_at, opened_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, seq, number, d.requesterNo, d.email, d.phone, d.consent ? 1 : 0, d.reason, now, d.consent ? 1 : 0,
    d.category, d.issue, d.location, assigned, dup ? dup.number : null, now, now);
    if (attachmentKey) {
      await c.run('INSERT INTO attachments(ticket_id, name, mime, size, storage_key) VALUES (?, ?, ?, ?, ?)',
        id, d.attachment.name, d.attachment.mime, d.attachment.data.length, attachmentKey);
    }
    await logEvent(id, 'requester', 'created', { to: 'New', note: d.consent ? null : 'Untracked: requester declined consent' }, c);
    return c.get('SELECT * FROM tickets WHERE id = ?', id);
  });

  const notifications = Promise.all([
    notify.requester(t, `Your IT Helpdesk ticket ${t.number} has been received. Track it at ${BASE_URL}/track.html`),
    t.assigned_to && notify.staff(t.assigned_to, `New ticket ${t.number} (${t.category}) assigned to you.`, t.id),
    checkWidespread(t),
  ]);
  return { ticket: t, notifications };
}

// Flag possible campus-wide problems: many tickets in the same category within 2 hours.
async function checkWidespread(t) {
  if (t.category === 'Other') return;
  const since = Date.now() - 2 * 3600000;
  const { c: n } = await db.get("SELECT COUNT(*) c FROM tickets WHERE category = ? AND created_at > ? AND status != 'Resolved'", t.category, since);
  if (n < await getSetting('widespreadThreshold')) return;
  await db.run("UPDATE tickets SET widespread = 1 WHERE category = ? AND created_at > ? AND status != 'Resolved'", t.category, since);
  // At most one alert per category per hour.
  if ((await hit(`widespread-alert:${t.category}`, 3600000)).n === 1) {
    await notify.admins(`Possible widespread issue: ${n} "${t.category}" tickets in the last 2 hours (latest ${t.number}${t.location ? ', ' + t.location : ''}).`, t.id);
  }
}

async function changeStatus(t, to, actor, note = null, pub = true) {
  if (!STATUSES.includes(to) || to === t.status) return;
  const now = Date.now();
  if (to === 'Resolved') await db.run('UPDATE tickets SET status = ?, resolved_at = ? WHERE id = ?', to, now, t.id);
  else await db.run('UPDATE tickets SET status = ?, resolved_at = NULL WHERE id = ?', to, t.id);
  await logEvent(t.id, actor, 'status', { from: t.status, to, note, pub });
  await audit(actor, 'ticket.status', `${t.number}: ${t.status} -> ${to}`);
  let msg = `Ticket ${t.number} is now "${to}".`;
  if (pub && note) msg += ` Note from IT: ${note}`;
  if (to === 'Resolved') msg += ` If the problem comes back within 7 days you can reopen it, and please rate our service: ${BASE_URL}/track.html`;
  notify.later(notify.requester(t, msg));
}

// ---------- Department referral links ----------
function linkUrl(token) {
  // The token is in the #fragment, so it never reaches server logs or Referer headers.
  return `${BASE_URL}/ref.html#t=${token}`;
}

async function referTicket(t, { department, surname, description }, user) {
  const dept = await db.get('SELECT * FROM departments WHERE code = ? AND active = 1', department);
  if (!dept) throw new Error('Unknown department.');
  let link = await db.get(`SELECT * FROM referral_links WHERE department = ? AND surname = ? AND revoked_at IS NULL
    AND expires_at > ? ORDER BY id DESC LIMIT 1`, department, surname, Date.now());
  let token = null;
  if (!link) {
    token = newToken();
    const expiresYmd = nthWorkingDay(localYmd(), await getSetting('linkWorkingDays'), await getSetting('holidays'));
    link = await db.get(`INSERT INTO referral_links(token_hash, department, surname, created_by, created_at, expires_ymd, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, sha256(token), department, surname, user.id, Date.now(), expiresYmd, endOfLocalDay(expiresYmd));
  }
  await db.run('INSERT INTO referrals(link_id, ticket_id, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    link.id, t.id, description, user.id, Date.now());
  await changeStatus(t, 'Referred to Department', user.username, `Referred to ${department}`, true);
  await logEvent(t.id, user.username, 'referral', { note: `${department} – ${surname}: ${description}` });

  const body = token
    ? `Dear ${surname},\n\nThe IT Helpdesk has referred an issue to you (ticket ${t.number}).\n\nOpen your secure link: ${linkUrl(token)}\n\n` +
      `You will be asked to confirm your department (${department}) and surname. The link is personal, lists every issue referred to you, ` +
      `and expires at the end of ${link.expires_ymd}. Please do not forward it.`
    : `Dear ${surname},\n\nTicket ${t.number} has been added to your existing IT Helpdesk referral link (valid until ${link.expires_ymd}).`;
  await notify.email(dept.email, `IT Helpdesk referral – ticket ${t.number}`, body);
  await audit(user.username, 'referral.created', `${t.number} -> ${department}/${surname} (link ${link.id})`);
  return { linkId: link.id, url: token ? linkUrl(token) : null, expires: link.expires_ymd };
}

async function resendLink(link, user) {
  const token = newToken();
  await db.run('UPDATE referral_links SET token_hash = ?, failed_attempts = 0 WHERE id = ?', sha256(token), link.id);
  const dept = await db.get('SELECT email FROM departments WHERE code = ?', link.department);
  await notify.email(dept.email, 'IT Helpdesk referral link (resent)',
    `Dear ${link.surname},\n\nHere is your new IT Helpdesk referral link: ${linkUrl(token)}\n\nAny earlier link no longer works. It expires at the end of ${link.expires_ymd}.`);
  await audit(user.username, 'referral.resent', `link ${link.id}`);
  return linkUrl(token);
}

async function extendLink(link, days, reason, user) {
  const from = link.expires_at > Date.now() ? nextYmd(link.expires_ymd) : localYmd();
  const ymd = nthWorkingDay(from, days, await getSetting('holidays'));
  await db.run('UPDATE referral_links SET expires_ymd = ?, expires_at = ?, reminder_sent = 0 WHERE id = ?', ymd, endOfLocalDay(ymd), link.id);
  await audit(user.username, 'referral.extended', `link ${link.id} to ${ymd}: ${reason}`);
  return ymd;
}

// Called by the Temporal user from the referral page.
async function resolveReferral(link, referralId, note) {
  const r = await db.get('SELECT * FROM referrals WHERE id = ? AND link_id = ? AND resolved_at IS NULL', referralId, link.id);
  if (!r) return false;
  const actor = `Temporal user (${link.department} – ${link.surname})`;
  await db.run('UPDATE referrals SET resolved_at = ?, resolution_note = ? WHERE id = ?', Date.now(), note, r.id);
  const t = await db.get('SELECT * FROM tickets WHERE id = ?', r.ticket_id);
  const { c: stillOpen } = await db.get('SELECT COUNT(*) c FROM referrals WHERE ticket_id = ? AND resolved_at IS NULL', t.id);
  if (!stillOpen) await changeStatus(t, 'Resolved', actor, note || `Resolved by ${link.department}`, true);
  else await logEvent(t.id, actor, 'note', { note: `Referral resolved${note ? ': ' + note : ''}` });
  await audit(actor, 'referral.resolved', `${t.number} (referral ${r.id})`);
  const msg = `Ticket ${t.number} was marked "Issue Resolved" by ${link.department} (${link.surname}).${note ? ' Note: ' + note : ''}`;
  notify.later(Promise.all([t.assigned_to && notify.staff(t.assigned_to, msg, t.id), notify.admins(msg, t.id)]));
  return true;
}

module.exports = { STATUSES, PRIORITIES, createTicket, changeStatus, referTicket, resendLink, extendLink, resolveReferral, linkUrl };
