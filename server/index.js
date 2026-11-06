'use strict';
// Local development server: serves the pages, runs the API and the jobs every 10 minutes.
// On Vercel this file is not used: pages come from public/ and the API from api/index.js.
const path = require('node:path');
const express = require('express');
const { setup } = require('./db');
const app = require('./app');
const jobs = require('./jobs');

(async () => {
  await setup();
  const server = express();
  server.use(app);
  server.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] })); // ETag revalidation
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`IT Helpdesk running on http://localhost:${port}`));
  const run = () => jobs.runAll().catch((e) => console.error('[jobs]', e));
  run();
  setInterval(run, 10 * 60 * 1000);
})();
