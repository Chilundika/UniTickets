'use strict';
// Notifications: in-system (notifications table) and outbound (outbox table).
// Every outbound message is written to the outbox first, then sent. Failed sends keep their
// error and are retried by the daily job (up to 3 attempts).
const { db } = require('./db');

const MAIL_FROM = process.env.MAIL_FROM || 'IT Helpdesk <onboarding@resend.dev>';

async function deliver({ id, channel, recipient, subject, body }) {
  try {
    if (channel === 'email' && process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: [recipient], subject, text: body }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } else if (channel === 'whatsapp' && process.env.WHATSAPP_WEBHOOK_URL) {
      // Point this at your WhatsApp Business / SMS gateway. It receives {to, text}.
      const r = await fetch(process.env.WHATSAPP_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN || ''}` },
        body: JSON.stringify({ to: recipient, text: body }),
      });
      if (!r.ok) throw new Error(`gateway ${r.status}`);
    } else {
      console.log(`[outbox:${channel}] to=${recipient} | ${subject || ''}\n${body}\n`);
    }
    await db.run('UPDATE outbox SET sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?', Date.now(), id);
  } catch (e) {
    await db.run('UPDATE outbox SET error = ?, attempts = attempts + 1 WHERE id = ?', String(e.message).slice(0, 300), id);
  }
}

async function queue(channel, recipient, subject, body) {
  const row = await db.get('INSERT INTO outbox(channel, recipient, subject, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    channel, recipient, subject, body, Date.now());
  await deliver({ id: row.id, channel, recipient, subject, body });
}

const email = async (to, subject, body) => { if (to) await queue('email', to, subject, body); };
const whatsapp = async (to, body) => { if (to) await queue('whatsapp', to, null, body); };

function inApp(userId, message, ticketId = null) {
  return db.run('INSERT INTO notifications(user_id, message, ticket_id, created_at) VALUES (?, ?, ?, ?)', userId, message, ticketId, Date.now());
}

// Notify a staff user in-system and by email.
async function staff(userId, message, ticketId = null) {
  const u = await db.get('SELECT email FROM users WHERE id = ? AND active = 1', userId);
  if (!u) return;
  await Promise.all([inApp(userId, message, ticketId), email(u.email, 'IT Helpdesk notification', message)]);
}
async function admins(message, ticketId = null) {
  const list = await db.all("SELECT id FROM users WHERE role = 'admin' AND active = 1");
  await Promise.all(list.map((a) => staff(a.id, message, ticketId)));
}

// Requesters are only contacted when they consented (tracked = 1).
async function requester(ticket, message) {
  if (!ticket.tracked) return;
  await Promise.all([email(ticket.email, `IT Helpdesk – Ticket ${ticket.number}`, message), whatsapp(ticket.phone, message)]);
}

// Retry failed messages from the last 2 days (called by the daily job).
async function retryFailed() {
  const rows = await db.all('SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < 3 AND created_at > ?', Date.now() - 2 * 86400000);
  for (const row of rows) await deliver(row);
  return rows.length;
}

// On Vercel, let the response go out first and finish sending in the background.
const { waitUntil } = require('@vercel/functions');
function later(promise) {
  const p = Promise.resolve(promise).catch((e) => console.error('[notify]', e));
  try { waitUntil(p); } catch { /* not on Vercel: the promise just runs */ }
  return p;
}

module.exports = { email, staff, admins, requester, inApp, retryFailed, later };
