'use strict';
// Environment settings, checked once at startup. In production a missing secret stops the app
// instead of silently running insecurely.
const crypto = require('node:crypto');

const env = process.env;
const ON_VERCEL = !!env.VERCEL;
const PROD = env.NODE_ENV === 'production' || ON_VERCEL;

function checkConfig(e = env) {
  const missing = [];
  if (!e.DATABASE_URL) missing.push('DATABASE_URL');
  if (!e.APP_SECRET || e.APP_SECRET.length < 32) missing.push('APP_SECRET (at least 32 characters)');
  if (!e.BASE_URL && !e.VERCEL_PROJECT_PRODUCTION_URL) missing.push('BASE_URL');
  if (!e.CRON_SECRET || e.CRON_SECRET.length < 16) missing.push('CRON_SECRET (at least 16 characters)');
  const warnings = [];
  if (!e.RESEND_API_KEY) warnings.push('RESEND_API_KEY not set: emails are only logged, not sent.');
  if (!e.TURNSTILE_SECRET_KEY || !e.TURNSTILE_SITE_KEY) warnings.push('Turnstile keys not set: using the weaker built-in arithmetic CAPTCHA.');
  if (!e.R2_ACCOUNT_ID || !e.R2_BUCKET) warnings.push('R2 not configured: file uploads are switched off.');
  return { missing, warnings };
}

if (PROD) {
  const { missing, warnings } = checkConfig();
  if (missing.length) throw new Error(`Refusing to start: missing production settings: ${missing.join(', ')}. See DEPLOY.md.`);
  for (const w of warnings) console.warn(`[config] ${w}`);
}

const BASE_URL = (env.BASE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')).replace(/\/$/, '');

module.exports = {
  PROD,
  ON_VERCEL,
  BASE_URL,
  checkConfig,
  APP_SECRET: env.APP_SECRET || crypto.randomBytes(32).toString('hex'), // random per run in development only
  CRON_SECRET: env.CRON_SECRET || '',
  TURNSTILE_SITE_KEY: env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY || '' : '',
  TURNSTILE_SECRET_KEY: env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SECRET_KEY || '' : '',
};
