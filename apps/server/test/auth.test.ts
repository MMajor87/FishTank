import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { ensureBootstrapCode } from '../src/codes.ts';
import { SESSION_COOKIE } from '../src/sessions.ts';

const ORIGIN = 'http://localhost:3000';
let app: FastifyInstance;
let db: DB;

before(async () => {
  db = openDb(':memory:');
  const config = { ...loadConfig({}), appOrigins: [ORIGIN] };
  app = await buildApp({ config, db }, { logger: false });
});
after(async () => {
  await app.close();
  db.close();
});

function post(url: string, payload: object, cookie?: string) {
  return app.inject({ method: 'POST', url, payload, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
}
function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((c) => c.name === SESSION_COOKIE);
  assert.ok(c, 'session cookie set');
  return `${SESSION_COOKIE}=${c.value}`;
}

let adminCookie = '';

test('bootstrap code creates the first account as admin', async () => {
  const code = ensureBootstrapCode(db);
  assert.match(code!, /^FISH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // Lower-case and without dashes still works (codes are normalized).
  const res = await post('/api/auth/register', {
    username: 'Captain',
    displayName: 'The Captain',
    password: 'correct horse battery',
    code: code!.toLowerCase().replace(/-/g, ''),
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().user.role, 'admin');
  adminCookie = sessionCookie(res);

  assert.equal(ensureBootstrapCode(db), null, 'no bootstrap once a user exists');
});

test('/api/me reflects the session; anonymous is 401', async () => {
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: adminCookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, 'Captain');

  const anon = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anon.statusCode, 401);
});

test('registration requires a valid, single-use code', async () => {
  const noCode = await post('/api/auth/register', { username: 'nemo', displayName: 'Nemo', password: 'just keep swimming', code: 'FISH-0000-0000-0000' });
  assert.equal(noCode.statusCode, 400);

  const created = await post('/api/registration-codes', { note: 'for nemo' }, adminCookie);
  assert.equal(created.statusCode, 201, created.body);
  const { code } = created.json();

  const ok = await post('/api/auth/register', { username: 'nemo', displayName: 'Nemo', password: 'just keep swimming', code });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().user.role, 'member');

  const reuse = await post('/api/auth/register', { username: 'dory', displayName: 'Dory', password: 'just keep swimming', code });
  assert.equal(reuse.statusCode, 400, 'code cannot be reused');

  const list = await app.inject({ method: 'GET', url: '/api/registration-codes', headers: { cookie: adminCookie } });
  assert.equal(list.json().codes[0].usedBy, 'nemo');
});

test('duplicate usernames are rejected case-insensitively, without burning the code', async () => {
  const { code } = (await post('/api/registration-codes', {}, adminCookie)).json();
  const dup = await post('/api/auth/register', { username: 'NEMO', displayName: 'Other', password: 'just keep swimming', code });
  assert.equal(dup.statusCode, 409);
  const retry = await post('/api/auth/register', { username: 'marlin', displayName: 'Marlin', password: 'just keep swimming', code });
  assert.equal(retry.statusCode, 201, 'code still usable after a failed attempt');
});

test('login: correct password works, wrong password and unknown user give the same error', async () => {
  const good = await post('/api/auth/login', { username: 'nemo', password: 'just keep swimming' });
  assert.equal(good.statusCode, 200);
  sessionCookie(good);

  const wrong = await post('/api/auth/login', { username: 'nemo', password: 'nope nope nope' });
  const unknown = await post('/api/auth/login', { username: 'bruce', password: 'nope nope nope' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().error, unknown.json().error);
});

test('state-changing requests from another origin are rejected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/registration-codes',
    payload: {},
    headers: { origin: 'https://evil.example', cookie: adminCookie },
  });
  assert.equal(res.statusCode, 403);
  const noOrigin = await app.inject({ method: 'POST', url: '/api/registration-codes', payload: {}, headers: { cookie: adminCookie } });
  assert.equal(noOrigin.statusCode, 403);
});

test('members can create codes but only up to the active limit; they can revoke their own', async () => {
  const login = await post('/api/auth/login', { username: 'marlin', password: 'just keep swimming' });
  const cookie = sessionCookie(login);
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/registration-codes', {}, cookie);
    assert.equal(r.statusCode, 201);
    ids.push(r.json().id);
  }
  assert.equal((await post('/api/registration-codes', {}, cookie)).statusCode, 429);

  const del = await app.inject({ method: 'DELETE', url: `/api/registration-codes/${ids[0]}`, headers: { origin: ORIGIN, cookie } });
  assert.equal(del.statusCode, 200);
  assert.equal((await post('/api/registration-codes', {}, cookie)).statusCode, 201, 'revoking frees a slot');

  const adminCode = (await post('/api/registration-codes', {}, adminCookie)).json();
  const other = await app.inject({ method: 'DELETE', url: `/api/registration-codes/${adminCode.id}`, headers: { origin: ORIGIN, cookie } });
  assert.equal(other.statusCode, 404, "members can't revoke other people's codes");
  const mine = (await app.inject({ method: 'GET', url: '/api/registration-codes', headers: { cookie } })).json().codes;
  assert.ok(mine.every((c: any) => c.createdBy === 'marlin'), 'members list only their own');
  assert.equal((await app.inject({ method: 'GET', url: '/api/registration-codes?all=1', headers: { cookie } })).statusCode, 403);
  const all = (await app.inject({ method: 'GET', url: '/api/registration-codes?all=1', headers: { cookie: adminCookie } })).json().codes;
  assert.ok(all.some((c: any) => c.createdBy === 'Captain') && all.some((c: any) => c.createdBy === 'marlin'), 'admins see everyone\'s');
});

test('accounts record who invited them, for the admin panel', async () => {
  const login = await post('/api/auth/login', { username: 'marlin', password: 'just keep swimming' });
  const cookie = sessionCookie(login);
  // Free a slot (the previous test filled marlin's 5).
  const active = (await app.inject({ method: 'GET', url: '/api/registration-codes', headers: { cookie } })).json().codes.find((c: any) => !c.usedAt && !c.revokedAt);
  await app.inject({ method: 'DELETE', url: `/api/registration-codes/${active.id}`, headers: { origin: ORIGIN, cookie } });
  const made = await post('/api/registration-codes', { note: 'for gill' }, cookie);
  assert.equal(made.statusCode, 201);

  const reg = await post('/api/auth/register', { username: 'gill', displayName: 'Gill', password: 'just keep swimming', code: made.json().code });
  assert.equal(reg.statusCode, 201);
  assert.equal(
    (await post('/api/auth/register', { username: 'guest-abc', displayName: 'x', password: 'just keep swimming', code: 'FISH-0000-0000-0000' })).statusCode,
    400,
  );

  const overview = (await app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie: adminCookie } })).json();
  assert.equal(overview.users.find((u: any) => u.username === 'gill').invitedBy, 'marlin');
  const log = overview.invites.find((i: any) => i.userName === 'gill');
  assert.equal(log.kind, 'account');
  assert.equal(log.invitedByName, 'marlin');
  assert.equal(overview.invites.find((i: any) => i.userName === 'Captain').invitedByName, null, 'bootstrap has no inviter');
});

test('logout ends the session', async () => {
  const login = await post('/api/auth/login', { username: 'nemo', password: 'just keep swimming' });
  const cookie = sessionCookie(login);
  await post('/api/auth/logout', {}, cookie);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.statusCode, 401);
});

test('disabled accounts cannot log in and lose existing sessions', async () => {
  const login = await post('/api/auth/login', { username: 'marlin', password: 'just keep swimming' });
  const cookie = sessionCookie(login);
  db.prepare("UPDATE users SET disabled = 1 WHERE username = 'marlin'").run();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode, 401);
  assert.equal((await post('/api/auth/login', { username: 'marlin', password: 'just keep swimming' })).statusCode, 401);
});

test('invite and sign-up codes are blanked out of logged URLs, other paths untouched', async () => {
  const { redactCodes } = await import('../src/app.ts');
  assert.equal(redactCodes('/join/TANK-7KQ2-M9XD-3TQA'), '/join/TANK-…');
  assert.equal(redactCodes('/api/tank-codes/tank-7kq2-m9xd-3tqa/guest'), '/api/tank-codes/tank-…/guest');
  assert.equal(redactCodes('/?code=FISH7KQ2M9XD3TQA'), '/?code=FISH-…');
  for (const keep of ['/api/tank-invites/1cb2dbf1-4860-453d-aeb0-b2856883ba82/accept', '/api/tanks/friends', '/api/tank-codes/redeem', '/api/registration-codes'])
    assert.equal(redactCodes(keep), keep);
});
