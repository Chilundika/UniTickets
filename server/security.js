'use strict';
// Security middleware: headers, HTTPS, rate limiting, CAPTCHA, sessions and role checks.
const crypto = require('node:crypto');
const { db } = require('./db');
const { newToken, sha256, safeEqual } = require('./lib');
const { PROD, APP_SECRET, TURNSTILE_SECRET_KEY } = require('./config');

const SESSION_IDLE_MS = 30 * 60 * 1000;       // signed out after 30 minutes idle
const SESSION_MAX_MS = 8 * 3600 * 1000;       // and after 8 hours at most
const COOKIE = PROD ? '__Host-sid' : 'sid';   // __Host- forces Secure, Path=/ and no Domain

// Keep in sync with the "headers" block in vercel.json (which covers the static pages on Vercel).
const CSP = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

function headers(req, res, next) {
  if (PROD && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store', // API responses carry personal data
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Fixed-window counter stored in Postgres, so every serverless instance shares it.
// Returns the number of hits in the current window.
async function hit(key, windowMs) {
  const now = Date.now();
  const row = await db.get(`INSERT INTO rate_limits(key, n, reset_at) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET
      n = CASE WHEN rate_limits.reset_at < ? THEN 1 ELSE rate_limits.n + 1 END,
      reset_at = CASE WHEN rate_limits.reset_at < ? THEN ? ELSE rate_limits.reset_at END
    RETURNING n, reset_at`, sha256(key), now + windowMs, now, now, now + windowMs);
  return row;
}

// keyFn returns the value to count by. Return null to skip (e.g. field missing).
// Campus Wi-Fi puts many students behind one IP address, so per-IP limits are generous and
// tighter limits are applied per student number or per ticket number instead.
function rateLimit(name, max, windowMs, keyFn = (req) => req.ip) {
  return async (req, res, next) => {
    const k = keyFn(req);
    if (k == null || k === '') return next();
    const { n, reset_at } = await hit(`${name}:${k}`, windowMs);
    if (n > max) {
      res.set('Retry-After', Math.ceil((reset_at - Date.now()) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

// ---------- CAPTCHA ----------
// Production: Cloudflare Turnstile (free, privacy-friendly, usually invisible).
// Development / fallback: a signed arithmetic question that needs no third-party service.
function newCaptcha() {
  const a = crypto.randomInt(2, 10), b = crypto.randomInt(2, 10);
  const exp = Date.now() + 15 * 60 * 1000;
  const sig = crypto.createHmac('sha256', APP_SECRET).update(`${a + b}|${exp}`).digest('base64url');
  return { question: `What is ${a} + ${b}?`, token: `${exp}.${sig}` };
}
async function checkCaptcha(body, ip) {
  if (TURNSTILE_SECRET_KEY) {
    if (!body.turnstileToken) return false;
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: TURNSTILE_SECRET_KEY, response: String(body.turnstileToken), remoteip: ip }),
      });
      return (await r.json()).success === true;
    } catch {
      return false;
    }
  }
  const [exp, sig] = String(body.captchaToken || '').split('.');
  if (!exp || Number(exp) < Date.now()) return false;
  const expect = crypto.createHmac('sha256', APP_SECRET).update(`${parseInt(body.captchaAnswer, 10)}|${exp}`).digest('base64url');
  return safeEqual(sig, expect);
}

// ---------- Sessions ----------
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, value, maxAgeS) {
  res.append('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${PROD ? '; Secure' : ''}`);
}
async function createSession(res, userId) {
  const token = newToken();
  const now = Date.now();
  await db.run('INSERT INTO sessions(id_hash, user_id, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, now + SESSION_IDLE_MS, now + SESSION_MAX_MS);
  setCookie(res, token, SESSION_MAX_MS / 1000);
}
async function destroySession(req, res) {
  const sid = cookies(req)[COOKIE];
  if (sid) await db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(sid));
  setCookie(res, '', 0);
}

// Loads req.user and slides the idle timeout.
async function loadUser(req, res, next) {
  const sid = cookies(req)[COOKIE];
  if (sid && req.path.startsWith('/api/')) {
    const now = Date.now();
    const row = await db.get(`SELECT u.*, s.id_hash FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND s.absolute_expires_at > ? AND u.active = 1`, sha256(sid), now, now);
    if (row) {
      await db.run('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', now + SESSION_IDLE_MS, row.id_hash);
      req.user = row;
    }
  }
  next();
}

// State-changing requests must also carry the X-Requested-With header: a cross-site form cannot
// set it, so this blocks CSRF on top of the SameSite=Strict cookie.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Bad request origin.' });
    if (req.user.must_change_pw && !req.path.startsWith('/api/me')) return res.status(403).json({ error: 'Please change your password first.', mustChangePassword: true });
    next();
  };
}

module.exports = { headers, hit, rateLimit, newCaptcha, checkCaptcha, createSession, destroySession, loadUser, requireRole, CSP };
