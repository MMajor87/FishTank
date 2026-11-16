import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { ensureBootstrapCode } from '../src/codes.ts';
import { SESSION_COOKIE } from '../src/sessions.ts';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/totp.ts';
import { backupDatabase } from '../src/backups.ts';
import { verifyPassword } from '../src/security.ts';

const ORIGIN = 'http://localhost:3000';
const PW = 'correct horse battery';
let app: FastifyInstance;
let db: DB;

before(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: { ...loadConfig({}), appOrigins: [ORIGIN] }, db }, { logger: false });
});
after(async () => {
  await app.close();
  db.close();
});

const post = (url: string, payload: object, cookie?: string) =>
  app.inject({ method: 'POST', url: `/api${url}`, payload, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
  `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
const codeAt = (secret: string, ms: number) => hotp(base32Decode(secret), Math.floor(ms / 30000));
const login = (password: string, code?: string) => post('/auth/login', { username: 'sec', password, ...(code ? { code } : {}) });

test('TOTP matches the RFC 6238 test vectors and base32 round-trips', () => {
  const key = Buffer.from('12345678901234567890');
  assert.equal(hotp(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.deepEqual(base32Decode(base32Encode(key)), key);
  const secret = base32Encode(key);
  const now = 1_700_000_000_000;
  assert.notEqual(verifyTotp(secret, codeAt(secret, now - 30000), null, now), null, 'previous step accepted (clock drift)');
  assert.equal(verifyTotp(secret, codeAt(secret, now - 90000), null, now), null, 'old codes rejected');
});

test('2FA: enroll, login needs a code, no replay, recovery codes work once, disable', async () => {
  const code = ensureBootstrapCode(db)!;
  const cookie = cookieOf(await post('/auth/register', { username: 'sec', displayName: 'Sec', password: PW, code }));

  assert.equal((await post('/account/2fa/setup', { password: 'wrong' }, cookie)).statusCode, 403);
  const setup = await post('/account/2fa/setup', { password: PW }, cookie);
  assert.equal(setup.statusCode, 200);
  const { secret, otpauthUrl } = setup.json();
  assert.match(otpauthUrl, /^otpauth:\/\/totp\/FishTank%3Asec\?secret=/);

  assert.equal((await post('/account/2fa/enable', { code: '000000' }, cookie)).statusCode, 400);
  const enabled = await post('/account/2fa/enable', { code: codeAt(secret, Date.now()) }, cookie);
  assert.equal(enabled.statusCode, 200, enabled.body);
  const recoveryCodes: string[] = enabled.json().recoveryCodes;
  assert.equal(recoveryCodes.length, 8);

  // Password alone is no longer enough, and no session is created.
  const noCode = await login(PW);
  assert.equal(noCode.statusCode, 401);
  assert.equal(noCode.json().totpRequired, true);
  assert.equal(noCode.cookies.length, 0);
  // A wrong password gets the generic error, with no hint that 2FA is on.
  assert.equal((await login('nope nope nope')).json().totpRequired, undefined);

  // The code used to enable can't be replayed; the next step's code works exactly once.
  assert.equal((await login(PW, codeAt(secret, Date.now()))).statusCode, 401);
  const next = codeAt(secret, Date.now() + 30000);
  assert.equal((await login(PW, next)).statusCode, 200);
  assert.equal((await login(PW, next)).statusCode, 401, 'replay rejected');

  // Recovery codes: case/dash-insensitive, single use.
  const rc = recoveryCodes[0]!;
  assert.equal((await login(PW, rc.toLowerCase().replace('-', ''))).statusCode, 200);
  assert.equal((await login(PW, rc)).statusCode, 401);
  const status = await app.inject({ method: 'GET', url: '/api/account/security', headers: { cookie } });
  assert.deepEqual(status.json(), { totpEnabled: true, recoveryCodesLeft: 7 });

  // Disabling needs the password and a second factor.
  assert.equal((await post('/account/2fa/disable', { password: PW, code: '123456' }, cookie)).statusCode, 403);
  assert.equal((await post('/account/2fa/disable', { password: PW, code: recoveryCodes[1]! }, cookie)).statusCode, 200);
  assert.equal((await login(PW)).statusCode, 200);
});

test('changing password signs out other sessions but keeps this one', async () => {
  const a = cookieOf(await login(PW));
  const b = cookieOf(await login(PW));
  assert.equal((await post('/account/password', { currentPassword: 'wrong', newPassword: 'another long password' }, a)).statusCode, 403);
  const res = await post('/account/password', { currentPassword: PW, newPassword: 'another long password' }, a);
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().signedOutSessions >= 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a } })).statusCode, 200, 'current session kept');
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: b } })).statusCode, 401, 'other session ended');
  // (Checked directly: this file has already used up the per-IP login rate limit, which is working as intended.)
  const { password_hash } = db.prepare("SELECT password_hash FROM users WHERE username = 'sec'").get() as { password_hash: string };
  assert.ok(await verifyPassword(password_hash, 'another long password'));
  assert.ok(!(await verifyPassword(password_hash, PW)));
});

test('security headers are set on app responses', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  const csp = String(res.headers['content-security-policy']);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src http:\/\/localhost:8081/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('backups: consistent copy of the live DB, keeps only the newest N', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ft-backup-'));
  try {
    const old = ['fishtank-20200101-000000.sqlite', 'fishtank-20200102-000000.sqlite', 'fishtank-20200103-000000.sqlite'];
    old.forEach((name, i) => {
      writeFileSync(join(dir, name), 'old');
      const t = new Date(2020, 0, 1 + i);
      utimesSync(join(dir, name), t, t);
    });
    const path = backupDatabase(db, dir, 2);
    const files = readdirSync(dir);
    assert.equal(files.length, 2);
    assert.ok(files.includes(path.split(/[\\/]/).pop()!), 'new backup kept');
    assert.ok(files.includes('fishtank-20200103-000000.sqlite'), 'newest old one kept');
    const copy = openDb(path);
    assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'sec'").get() as { n: number }).n, 1);
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
