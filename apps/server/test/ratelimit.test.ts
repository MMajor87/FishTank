import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { hashPassword } from '../src/security.ts';

// Every request here comes from the same IP — exactly the situation behind Docker Desktop.
const ORIGIN = 'http://localhost:3000';
let app: FastifyInstance;
let db: DB;

before(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: { ...loadConfig({}), appOrigins: [ORIGIN] }, db }, { logger: false });
  const hash = await hashPassword('the right password');
  for (const u of ['victim', 'bystander']) {
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), u, u, hash, Date.now());
  }
});
after(async () => {
  await app.close();
  db.close();
});

const login = (username: string, password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: { origin: ORIGIN } });

test('hammering one username locks only that username, not everyone on the same IP', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('victim', 'guess ' + i)).statusCode, 401);
  assert.equal((await login('victim', 'the right password')).statusCode, 429, 'victim is throttled');
  assert.equal((await login('VICTIM', 'the right password')).statusCode, 429, 'case variants share the limit');
  assert.equal((await login('bystander', 'the right password')).statusCode, 200, 'others on the same IP are unaffected');
});

test('a global cap stops large-scale guessing across many usernames', async () => {
  let blocked = false;
  for (let i = 0; i < 320 && !blocked; i++) {
    const res = await login(`nobody-${i}`, 'wrong password!');
    if (res.statusCode === 429) blocked = true;
  }
  assert.ok(blocked, 'failed-login cap reached');
  assert.equal((await login('bystander', 'the right password')).statusCode, 429, 'while the cap is hit, logins pause briefly');
});
