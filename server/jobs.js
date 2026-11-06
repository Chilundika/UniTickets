'use strict';
// Scheduled jobs: escalation, link expiry reminders, message retries, data retention, clean-up.
// On Vercel the free cron runs them once a day (see vercel.json); locally every 10 minutes.
// Each job records what it already did, so running it more often is safe.
const { db, getSetting, audit, logEvent } = require('./db');
const { localYmd, workingDaysBetween } = require('./lib');
const storage = require('./storage');
const notify = require('./notify');

async function runEscalation(now = Date.now()) {
  const holidays = await getSetting('holidays');
  const remindAt = await getSetting('reminderWorkingDays');
  const escalateAt = await getSetting('escalationWorkingDays');
  const today = localYmd(now);
  const open = await db.all(`SELECT t.*, u.username FROM tickets t LEFT JOIN users u ON u.id = t.assigned_to
    WHERE t.status NOT IN ('Resolved', 'Referred to Department') AND (t.reminded_at IS NULL OR t.escalated_at IS NULL)`);

  for (const t of open) {
    const days = workingDaysBetween(localYmd(t.opened_at), today, holidays);
    if (days >= remindAt && !t.reminded_at && t.assigned_to) {
      await notify.staff(t.assigned_to, `Reminder: Ticket ${t.number} has been open for ${days} working days.`, t.id);
      await db.run('UPDATE tickets SET reminded_at = ? WHERE id = ?', now, t.id);
    }
    if (days >= escalateAt && !t.escalated_at) {
      const who = t.username ? `assigned to ${t.username}` : 'unassigned';
      await notify.admins(`Ticket ${t.number} ${who} has been unresolved for ${escalateAt}+ working days.`, t.id);
      await db.run("UPDATE tickets SET escalated_at = ?, status = 'Needs Escalation' WHERE id = ?", now, t.id);
      if (t.status !== 'Needs Escalation') await logEvent(t.id, 'system', 'status', { from: t.status, to: 'Needs Escalation', note: `Unresolved for ${days} working days` });
      await audit('system', 'ticket.escalated', t.number);
    }
  }
}

async function runLinkReminders(now = Date.now()) {
  const holidays = await getSetting('holidays');
  const today = localYmd(now);
  const links = await db.all(`SELECT l.*, d.email FROM referral_links l JOIN departments d ON d.code = l.department
    WHERE l.revoked_at IS NULL AND l.reminder_sent = 0 AND l.expires_at > ?`, now);
  for (const l of links) {
    const { c: pending } = await db.get('SELECT COUNT(*) c FROM referrals WHERE link_id = ? AND resolved_at IS NULL', l.id);
    if (pending && workingDaysBetween(today, l.expires_ymd, holidays) <= 1) {
      await notify.email(l.email, 'Reminder: IT Helpdesk referral link expires soon',
        `Dear ${l.surname},\n\nYour IT Helpdesk referral link expires at the end of ${l.expires_ymd}. ` +
        `${pending} issue(s) are still open. Please use the link from the original email, or ask IT to resend it.`);
      await db.run('UPDATE referral_links SET reminder_sent = 1 WHERE id = ?', l.id);
    }
  }
}

// Data Protection Act: keep personal data no longer than needed.
async function runRetention(now = Date.now()) {
  const cutoff = now - (await getSetting('retentionDays')) * 86400000;
  const old = await db.all("SELECT id FROM tickets WHERE anonymised = 0 AND status = 'Resolved' AND resolved_at < ?", cutoff);
  for (const { id } of old) {
    for (const a of await db.all('SELECT storage_key FROM attachments WHERE ticket_id = ?', id)) await storage.remove(a.storage_key);
    await db.run('DELETE FROM attachments WHERE ticket_id = ?', id);
    await db.run('UPDATE tickets SET requester_no = NULL, email = NULL, phone = NULL, anonymised = 1 WHERE id = ?', id);
  }
  if (old.length) await audit('system', 'retention.anonymised', `${old.length} tickets`);
}

async function runCleanup(now = Date.now()) {
  await db.run('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?', now, now);
  await db.run('DELETE FROM rate_limits WHERE reset_at < ?', now);
}

async function runAll() {
  const report = {};
  for (const job of [runEscalation, runLinkReminders, notify.retryFailed, runRetention, runCleanup]) {
    try { report[job.name] = (await job()) ?? 'ok'; } catch (e) { console.error(`[jobs] ${job.name} failed:`, e); report[job.name] = 'failed'; }
  }
  return report;
}

module.exports = { runAll, runEscalation, runLinkReminders, runRetention, runCleanup };
