'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../server/lib');

test('ticket numbering: A01..A50, B01, Z50, AA01', () => {
  assert.equal(L.ticketNumber(0), 'A01');
  assert.equal(L.ticketNumber(6), 'A07');
  assert.equal(L.ticketNumber(49), 'A50');
  assert.equal(L.ticketNumber(50), 'B01');
  assert.equal(L.ticketNumber(56), 'B07');
  assert.equal(L.ticketNumber(26 * 50 - 1), 'Z50');
  assert.equal(L.ticketNumber(26 * 50), 'AA01');
  assert.equal(L.ticketNumber(27 * 50), 'AB01');
  assert.equal(L.ticketNumber((26 + 26 * 26) * 50), 'AAA01');
});

test('ticket numbers never repeat within a long run', () => {
  const seen = new Set();
  for (let i = 0; i < 50000; i++) seen.add(L.ticketNumber(i));
  assert.equal(seen.size, 50000);
});

test('working days skip weekends and holidays', () => {
  // 2026-11-02 is a Monday
  assert.equal(L.isWorkingDay('2026-11-02'), true);
  assert.equal(L.isWorkingDay('2026-11-07'), false); // Saturday
  assert.equal(L.workingDaysBetween('2026-11-02', '2026-11-05'), 3); // Mon -> Thu
  assert.equal(L.workingDaysBetween('2026-11-06', '2026-11-09'), 1); // Fri -> Mon
  assert.equal(L.workingDaysBetween('2026-11-02', '2026-11-05', ['2026-11-04']), 2);
  assert.equal(L.workingDaysBetween('2026-12-31', '2027-01-04'), 2); // year boundary: Fri 1 Jan + Mon 4 Jan
  assert.equal(L.workingDaysBetween('2026-12-31', '2027-01-04', ['2027-01-01']), 1);
});

test('link expiry: 5 working days counting the creation day', () => {
  assert.equal(L.nthWorkingDay('2026-11-02', 5), '2026-11-06'); // Mon -> Fri
  assert.equal(L.nthWorkingDay('2026-11-04', 5), '2026-11-10'); // Wed -> next Tue
  assert.equal(L.nthWorkingDay('2026-11-07', 5), '2026-11-13'); // created Sat -> Fri
  assert.equal(L.nthWorkingDay('2026-11-02', 5, ['2026-11-03']), '2026-11-09');
});

test('Lusaka local date is UTC+2', () => {
  assert.equal(L.localYmd(Date.UTC(2026, 10, 2, 21, 59)), '2026-11-02');
  assert.equal(L.localYmd(Date.UTC(2026, 10, 2, 22, 0)), '2026-11-03');
  assert.equal(L.endOfLocalDay('2026-11-02'), Date.UTC(2026, 10, 2, 21, 59, 59, 999));
});

test('passwords hash and verify', () => {
  const h = L.hashPassword('correct horse battery');
  assert.ok(L.verifyPassword('correct horse battery', h));
  assert.ok(!L.verifyPassword('wrong', h));
});

test('TOTP matches RFC 6238 test vector', () => {
  const secret = L.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(L.totp(secret, 59000), '287082');
  assert.ok(L.verifyTotp(secret, '287082', 59000));
  assert.ok(!L.verifyTotp(secret, '000000', 59000));
});

test('validation', () => {
  assert.ok(L.RX.phone.test(L.normalisePhone('+260 97 123 4567')));
  assert.ok(!L.RX.phone.test('0971234567'));
  assert.ok(L.RX.email.test('a.b@uni.ac.zm'));
  assert.equal(L.sentenceCount('One. Two! Three?'), 3);
  assert.equal(L.clean('  hi\u0000 '), 'hi');
});
