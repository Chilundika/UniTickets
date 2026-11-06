'use strict';
// Create tables and default settings. Safe to run any number of times.
// Vercel runs this on every deploy (buildCommand in vercel.json).
const { setup, end } = require('../server/db');

setup()
  .then(() => console.log(process.env.DATABASE_URL ? 'Database is ready.' : 'Local database (PGlite) is ready.'))
  .catch((e) => { console.error('Database setup failed:', e.message); process.exitCode = 1; })
  .finally(end);
