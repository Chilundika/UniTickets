'use strict';
// Recover access when no other admin can help (e.g. the only admin lost their phone).
//   npm run reset-user -- IT-CU411 2fa        -> 2FA is set up again at next sign-in
//   npm run reset-user -- IT-CU411 password   -> prints a new temporary password
//   npm run reset-user -- IT-CU411 both
// Also re-enables a disabled account and signs the user out everywhere.
const { db, audit, end } = require('../server/db');
const L = require('../server/lib');

(async () => {
  const [id, what = 'both'] = process.argv.slice(2);
  const username = `IT-${String(id || '').toUpperCase().replace(/^IT-/, '')}`;
  if (!L.RX.username.test(username) || !['2fa', 'password', 'both'].includes(what)) {
    throw new Error('Usage: npm run reset-user -- <IT-ID> [2fa|password|both]');
  }
  const u = await db.get('SELECT id FROM users WHERE username = ?', username);
  if (!u) throw new Error(`${username} does not exist.`);
  if (what !== 'password') await db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?', u.id);
  if (what !== '2fa') {
    const password = L.randomPassword();
    await db.run('UPDATE users SET pw_hash = ?, must_change_pw = 1 WHERE id = ?', L.hashPassword(password), u.id);
    console.log(`Temporary password for ${username}: ${password}`);
  }
  await db.run('UPDATE users SET active = 1 WHERE id = ?', u.id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  await audit('cli', 'user.reset', `${username}: ${what}`);
  console.log(`Reset ${what} for ${username}. They will set it up again at next sign-in.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(end);
