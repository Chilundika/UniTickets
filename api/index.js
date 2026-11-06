'use strict';
// Vercel serverless function: every /api/* request is routed here by vercel.json.
// The pages in public/ are served directly by Vercel's CDN.
module.exports = require('../server/app');
