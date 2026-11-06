'use strict';
// The Express app, shared by Vercel (api/index.js) and local development (server/index.js).
const config = require('./config'); // first: refuses to start in production without required secrets
const express = require('express');
const security = require('./security');
const jobs = require('./jobs');
const { safeEqual } = require('./lib');

const app = express();
app.disable('x-powered-by');
// Client IP for rate limits and the audit log. Vercel sets X-Forwarded-For itself (clients cannot
// spoof it there). Elsewhere, only trust a proxy on this machine unless TRUST_PROXY says otherwise.
const tp = process.env.TRUST_PROXY;
app.set('trust proxy', config.ON_VERCEL ? true : tp ? (/^\d+$/.test(tp) ? Number(tp) : tp) : 'loopback');
app.use(security.headers);

// Daily jobs. Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>".
app.get('/api/cron', async (req, res) => {
  if (!config.CRON_SECRET || !safeEqual(req.get('Authorization') || '', `Bearer ${config.CRON_SECRET}`)) {
    return res.status(401).json({ error: 'Not allowed.' });
  }
  res.json(await jobs.runAll());
});

app.use(security.loadUser);
app.use(require('./public-routes'));
app.use(require('./staff-routes'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large (max 2 MB).' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
