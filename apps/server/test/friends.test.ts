import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { SESSION_COOKIE, createSession } from '../src/sessions.ts';

const ORIGIN = 'http://localhost:3000';
let app: FastifyInstance;
let db: DB;

interface TestUser {
  id: string;
  username: string;
  cookie: string;
}

before(async () => {
  db = openDb(':memory:');
  app = await buildApp({ config: { ...loadConfig({}), appOrigins: [ORIGIN] }, db }, { logger: false });
});
after(async () => {
  await app.close();
  db.close();
});

/** Creates a user + session directly (skips argon2 to keep tests fast). */
function makeUser(username: string): TestUser {
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)").run(
    id,
    username,
    username[0]!.toUpperCase() + username.slice(1),
    Date.now(),
  );
  return { id, username, cookie: `${SESSION_COOKIE}=${createSession(db, id, 30)}` };
}

function call(u: TestUser, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url: `/api${url}`, payload, headers: { cookie: u.cookie, origin: ORIGIN } });
}
const relations = async (u: TestUser) => (await call(u, 'GET', '/friends')).json();

/** Opens a WebSocket as `u` and records every message it receives. */
async function connect(u: TestUser) {
  const messages: any[] = [];
  const ws: WebSocket = await app.injectWS(
    '/api/ws',
    { headers: { cookie: u.cookie, origin: ORIGIN } },
    { onInit: (s) => s.on('message', (d) => messages.push(JSON.parse(String(d)))) },
  );
  const waitFor = async (pred: (m: any) => boolean, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out waiting for message; got ${JSON.stringify(messages)}`);
  };
  return { ws, messages, waitFor };
}

test('request → accept makes two users friends', async () => {
  const a = makeUser('anchovy');
  const b = makeUser('barracuda');

  const sent = await call(a, 'POST', '/friends/requests', { username: 'Barracuda' }); // case-insensitive
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal((await relations(a)).outgoing[0].username, 'barracuda');
  assert.equal((await relations(b)).incoming[0].username, 'anchovy');

  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'barracuda' })).statusCode, 409, 'no duplicate');

  const acc = await call(b, 'POST', `/friends/requests/${a.id}/accept`);
  assert.equal(acc.statusCode, 200, acc.body);
  const ra = await relations(a);
  assert.equal(ra.friends.length, 1);
  assert.equal(ra.friends[0].username, 'barracuda');
  assert.equal(ra.outgoing.length, 0);
  assert.equal((await relations(b)).friends[0].username, 'anchovy');

  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'barracuda' })).json().error, "You're already friends");
});

test('you cannot accept your own outgoing request', async () => {
  const a = makeUser('cod');
  const b = makeUser('dab');
  await call(a, 'POST', '/friends/requests', { username: 'dab' });
  assert.equal((await call(a, 'POST', `/friends/requests/${b.id}/accept`)).statusCode, 404);
});

test('mutual requests become a friendship automatically', async () => {
  const a = makeUser('eel');
  makeUser('flounder');
  const b = { ...makeUser('flounder2') };
  await call(a, 'POST', '/friends/requests', { username: 'flounder2' });
  const back = await call(b, 'POST', '/friends/requests', { username: 'eel' });
  assert.equal(back.json().status, 'accepted');
  assert.equal((await relations(a)).friends[0].username, 'flounder2');
});

test('unknown user, self, decline, cancel, remove', async () => {
  const a = makeUser('grouper');
  const b = makeUser('halibut');
  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'nobody-here' })).statusCode, 404);
  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'grouper' })).statusCode, 400);

  await call(a, 'POST', '/friends/requests', { username: 'halibut' });
  assert.equal((await call(b, 'DELETE', `/friends/requests/${a.id}`)).statusCode, 200, 'decline');
  assert.equal((await relations(a)).outgoing.length, 0);

  await call(a, 'POST', '/friends/requests', { username: 'halibut' });
  assert.equal((await call(a, 'DELETE', `/friends/requests/${b.id}`)).statusCode, 200, 'cancel');

  await call(a, 'POST', '/friends/requests', { username: 'halibut' });
  await call(b, 'POST', `/friends/requests/${a.id}/accept`);
  assert.equal((await call(b, 'DELETE', `/friends/${a.id}`)).statusCode, 200, 'remove');
  assert.equal((await relations(a)).friends.length, 0);
  assert.equal((await call(b, 'DELETE', `/friends/${a.id}`)).statusCode, 404);
});

test('blocking removes the friendship and hides the blocker', async () => {
  const a = makeUser('ide');
  const b = makeUser('jack');
  await call(a, 'POST', '/friends/requests', { username: 'jack' });
  await call(b, 'POST', `/friends/requests/${a.id}/accept`);

  assert.equal((await call(a, 'POST', '/blocks', { userId: b.id })).statusCode, 200);
  assert.equal((await relations(a)).friends.length, 0);
  assert.equal((await relations(b)).friends.length, 0);
  assert.equal((await relations(a)).blocked[0].username, 'jack');

  // Blocked user sees the same response as for a nonexistent username.
  const fromBlocked = await call(b, 'POST', '/friends/requests', { username: 'ide' });
  const nonexistent = await call(b, 'POST', '/friends/requests', { username: 'zzz-none' });
  assert.equal(fromBlocked.statusCode, 404);
  assert.equal(fromBlocked.json().error, nonexistent.json().error);

  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'jack' })).statusCode, 409, 'blocker must unblock first');
  assert.equal((await call(a, 'DELETE', `/blocks/${b.id}`)).statusCode, 200);
  assert.equal((await call(a, 'POST', '/friends/requests', { username: 'jack' })).statusCode, 201);
});

test('friends endpoints require login and same-origin', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/friends' })).statusCode, 401);
  const a = makeUser('koi');
  const evil = await app.inject({
    method: 'POST',
    url: '/api/friends/requests',
    payload: { username: 'x' },
    headers: { cookie: a.cookie, origin: 'https://evil.example' },
  });
  assert.equal(evil.statusCode, 403);
  assert.equal((await call(a, 'POST', '/blocks', { userId: 'not-a-uuid' })).statusCode, 400);
});

test('websocket: rejects anonymous and cross-origin connections', async () => {
  const a = makeUser('ling');
  await assert.rejects(app.injectWS('/api/ws', { headers: { origin: ORIGIN } }));
  await assert.rejects(app.injectWS('/api/ws', { headers: { cookie: a.cookie, origin: 'https://evil.example' } }));
  await assert.rejects(app.injectWS('/api/ws', { headers: { cookie: a.cookie } }));
});

test('websocket: live friend events and presence', async () => {
  const a = makeUser('marlin2');
  const b = makeUser('nemo2');
  const sa = await connect(a);
  await sa.waitFor((m) => m.type === 'hello' && m.user.username === 'marlin2');

  // Request arrives live, with who sent it.
  const sb = await connect(b);
  await call(b, 'POST', '/friends/requests', { username: 'marlin2' });
  const ev = await sa.waitFor((m) => m.type === 'friends.changed' && m.reason === 'request');
  assert.equal(ev.by.username, 'nemo2');

  // Before they're friends, presence is not shared.
  assert.ok(!sa.messages.some((m) => m.type === 'presence'));

  await call(a, 'POST', `/friends/requests/${b.id}/accept`);
  await sb.waitFor((m) => m.type === 'friends.changed' && m.reason === 'accepted');
  assert.equal((await relations(a)).friends[0].online, true);

  // b goes offline → a is told.
  sb.ws.terminate();
  await sa.waitFor((m) => m.type === 'presence' && m.userId === b.id && m.online === false);
  assert.equal((await relations(a)).friends[0].online, false);

  // b comes back → a is told.
  const sb2 = await connect(b);
  await sa.waitFor((m) => m.type === 'presence' && m.userId === b.id && m.online === true);
  sb2.ws.terminate();
  sa.ws.terminate();
});

test('websocket: logout closes that session\'s sockets', async () => {
  const a = makeUser('orca');
  const s = await connect(a);
  await s.waitFor((m) => m.type === 'hello');
  const closed = new Promise<number>((r) => s.ws.on('close', (code) => r(code)));
  await call(a, 'POST', '/auth/logout', {});
  assert.equal(await closed, 4001);
});

test('websocket: heartbeat closes sockets whose account was disabled', async () => {
  const a = makeUser('pike');
  const s = await connect(a);
  await s.waitFor((m) => m.type === 'hello');
  const closed = new Promise<number>((r) => s.ws.on('close', (code) => r(code)));
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(a.id);
  app.hub.sweep((c) => c.userId !== a.id); // what the 30s heartbeat does, with the real check stubbed
  assert.equal(await closed, 4001);
});
