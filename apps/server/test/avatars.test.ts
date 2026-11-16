import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { SESSION_COOKIE, createSession } from '../src/sessions.ts';
import { sniffImage } from '../src/avatars.ts';

const ORIGIN = 'http://localhost:3000';
// 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
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

function makeUser(username: string) {
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)").run(id, username, username, Date.now());
  return { id, cookie: `${SESSION_COOKIE}=${createSession(db, id, 30)}` };
}
const req = (method: 'GET' | 'PUT' | 'DELETE', url: string, cookie?: string, payload?: object) =>
  app.inject({ method, url: `/api${url}`, payload, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

test('sniffing accepts PNG/JPEG/WebP by content and rejects everything else (incl. SVG)', () => {
  assert.equal(sniffImage(Buffer.from(PNG, 'base64')), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a')), null);
});

test('upload, view (logged in only), versioned URL in /me and friends lists, delete', async () => {
  const a = makeUser('ava');
  const b = makeUser('bob');
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  db.prepare("INSERT INTO friendships (user_low_id, user_high_id, status, requested_by, created_at, accepted_at) VALUES (?, ?, 'accepted', ?, 0, 0)").run(lo, hi, a.id);

  assert.equal((await req('GET', '/me', a.cookie)).json().user.avatarUrl, null);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  assert.equal((await req('PUT', '/account/avatar', a.cookie, { image: svg })).statusCode, 415);
  const big = Buffer.alloc(210 * 1024, 1);
  big.set(Buffer.from(PNG, 'base64').subarray(0, 8));
  assert.ok([413].includes((await req('PUT', '/account/avatar', a.cookie, { image: big.toString('base64') })).statusCode));

  const up = await req('PUT', '/account/avatar', a.cookie, { image: `data:image/png;base64,${PNG}` });
  assert.equal(up.statusCode, 200, up.body);
  const url: string = up.json().avatarUrl;
  assert.match(url, new RegExp(`^/api/avatars/${a.id}\\?v=\\d+$`));

  assert.equal((await req('GET', '/me', a.cookie)).json().user.avatarUrl, url);
  assert.equal((await req('GET', '/friends', b.cookie)).json().friends[0].avatarUrl, url, 'friends see it');

  const img = await app.inject({ method: 'GET', url, headers: { cookie: b.cookie } });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.match(String(img.headers['cache-control']), /immutable/);
  assert.deepEqual(img.rawPayload, Buffer.from(PNG, 'base64'));
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, 'anonymous cannot view');

  assert.equal((await req('DELETE', '/account/avatar', a.cookie)).statusCode, 200);
  assert.equal((await req('GET', '/me', a.cookie)).json().user.avatarUrl, null);
  assert.equal((await app.inject({ method: 'GET', url, headers: { cookie: b.cookie } })).statusCode, 404);
});
