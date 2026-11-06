'use strict';
// Pure helpers: ticket numbering, working days, tokens, passwords, TOTP, validation.
// No database access here, so everything in this file is unit-tested directly.
const crypto = require('node:crypto');

const TZ = 'Africa/Lusaka';
const TZ_OFFSET_MS = 2 * 3600 * 1000; // Zambia is UTC+2 all year (no daylight saving)

// ---------- Ticket numbering ----------
// n is a global 0-based counter. 50 tickets per letter block:
// 0 -> A01, 49 -> A50, 50 -> B01, ... Z50, then AA01, AB01 ...
const PER_BLOCK = 50;
function blockLetters(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}
function ticketNumber(n) {
  return blockLetters(Math.floor(n / PER_BLOCK)) + String((n % PER_BLOCK) + 1).padStart(2, '0');
}

// ---------- Dates & working days (all dates are 'YYYY-MM-DD' in Lusaka time) ----------
function localYmd(ms = Date.now()) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
function ymdToDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function nextYmd(ymd) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function isWorkingDay(ymd, holidays = []) {
  const wd = ymdToDate(ymd).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.includes(ymd);
}
// Number of working days d with start < d <= end. Created Monday -> Thursday = 3.
function workingDaysBetween(startYmd, endYmd, holidays = []) {
  let count = 0;
  for (let d = nextYmd(startYmd); d <= endYmd; d = nextYmd(d)) {
    if (isWorkingDay(d, holidays)) count++;
  }
  return count;
}
// The n-th working day counting from startYmd (inclusive).
// Link created Monday, n=5 -> expires end of Friday.
function nthWorkingDay(startYmd, n, holidays = []) {
  let d = startYmd;
  let count = 0;
  for (;;) {
    if (isWorkingDay(d, holidays) && ++count === n) return d;
    d = nextYmd(d);
  }
}
// End of a Lusaka calendar day as a UTC epoch (ms).
function endOfLocalDay(ymd) {
  return ymdToDate(ymd).getTime() + 24 * 3600 * 1000 - 1 - TZ_OFFSET_MS;
}
function startOfLocalDay(ymd) {
  return ymdToDate(ymd).getTime() - TZ_OFFSET_MS;
}

// ---------- Tokens ----------
const newToken = () => crypto.randomBytes(32).toString('base64url'); // 256-bit
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const uuid = () => crypto.randomUUID();
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Passwords (scrypt, no extra dependency) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// ---------- TOTP (RFC 6238, works with Google/Microsoft Authenticator) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
function totp(secret, ms = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
function verifyTotp(secret, code, ms = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  return [-1, 0, 1].some((w) => safeEqual(totp(secret, ms + w * 30000), code));
}

// ---------- Validation ----------
// Strip control characters and trim. Output is always rendered with textContent,
// and SQL always uses bound parameters, so this is defence in depth.
function clean(v, max = 200) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
const RX = {
  requesterNo: /^[A-Za-z0-9\/-]{3,20}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  phone: /^\+[1-9]\d{7,14}$/, // E.164, e.g. +260971234567
  surname: /^[A-Za-z' -]{2,40}$/,
  username: /^IT-[A-Z0-9]{2,20}$/,
};
const normalisePhone = (p) => clean(p, 30).replace(/[\s()-]/g, '');
const sentenceCount = (s) => s.split(/[.!?]+/).filter((x) => x.trim()).length;
const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

module.exports = {
  TZ, ticketNumber, blockLetters, localYmd, nextYmd, isWorkingDay, workingDaysBetween,
  nthWorkingDay, endOfLocalDay, startOfLocalDay, newToken, sha256, uuid, safeEqual,
  hashPassword, verifyPassword, randomPassword, newTotpSecret, totp, verifyTotp,
  base32Encode, clean, RX, normalisePhone, sentenceCount, wordCount,
};
