'use strict';
// Create the first SUDO admin (or any user) from the command line.
//   npm run create-user -- CU001 "Jane Banda" jane.banda@example.edu admin
// Uses DATABASE_URL from .env (your Neon database), or the local database without it.
const { db, setup, audit, end } = require('../server/db');
const L = require('../server/lib');

(async () => {
  const [staffId, fullName, email, role = 'it'] = process.argv.slice(2);
  const username = `IT-${String(staffId || '').toUpperCase().replace(/^IT-/, '')}`;
  if (!L.RX.username.test(username) || !fullName || !L.RX.email.test(email || '') || !['it', 'admin'].includes(role)) {
    throw new Error('Usage: npm run create-user -- <StaffID> "<Full Name>" <email> [it|admin]');
  }
  await setup();
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new Error(`${username} already exists.`);
  const password = L.randomPassword();
  await db.run('INSERT INTO users(username, full_name, email, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    username, fullName, email.toLowerCase(), role, L.hashPassword(password), Date.now());
  await audit('cli', 'user.created', `${username} (${role})`);
  console.log(`Created ${username} (${role}). Temporary password: ${password}`);
  console.log(role === 'admin' ? 'At first sign-in you will set up 2FA and change this password.' : 'The password must be changed at first sign-in.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(end);
