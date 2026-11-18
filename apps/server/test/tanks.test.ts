import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { FakeOrchestrator } from './fake-orchestrator.ts';
import { SESSION_COOKIE, createSession } from '../src/sessions.ts';
import { ensureBootstrapCode } from '../src/codes.ts';
import { GUEST_GRACE_MS } from '../src/tanks.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'http://localhost:3000';
const TANK_ORIGIN = 'https://tanks.test';

let app: FastifyInstance;
let db: DB;
let orch: FakeOrchestrator;
let config: Config;

interface U {
  id: string;
  username: string;
  cookie: string;
}

before(async () => {
  db = openDb(':memory:');
  orch = new FakeOrchestrator();
  const base = loadConfig({});
  config = {
    ...base,
    appOrigins: [ORIGIN],
    publicUrl: ORIGIN,
    tanks: { ...base.tanks, origin: TANK_ORIGIN, maxTanks: 3, maxPerHost: 1, portRange: [59000, 59002], idleMinutes: 15, maxHours: 8 },
  };
  app = await buildApp({ config, db, orchestrator: orch }, { logger: false });
});
after(async () => {
  await app.close();
  db.close();
});

function makeUser(username: string): U {
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)").run(id, username, username, Date.now());
  return { id, username, cookie: `${SESSION_COOKIE}=${createSession(db, id, 30)}` };
}
function befriend(a: U, b: U) {
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  db.prepare("INSERT INTO friendships (user_low_id, user_high_id, status, requested_by, created_at, accepted_at) VALUES (?, ?, 'accepted', ?, ?, ?)").run(lo, hi, a.id, Date.now(), Date.now());
}
function call(u: U | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url: `/api${url}`, payload, headers: { origin: ORIGIN, ...(u ? { cookie: u.cookie } : {}) } });
}
async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function openTank(host: U, name = 'Movie night'): Promise<string> {
  const res = await call(host, 'POST', '/tanks', { name });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().tank.id as string;
  await until(() => app.tanks.get(id)?.status === 'open');
  return id;
}
/** Opens the Tank page and follows the iframe's first request (ticket → cookies), like a browser. */
async function signIn(u: U, tankId: string) {
  const embed = new URL((await call(u, 'GET', `/tanks/${tankId}`)).json().embedUrl);
  return forwardAuth(tankId, embed.pathname + embed.search);
}
/** Simulates Caddy's forward_auth call for a Tank-origin request. */
function forwardAuth(tankId: string, uri: string, cookie?: string) {
  return app.inject({ method: 'GET', url: `/auth/tank/${tankId}`, headers: { 'x-forwarded-uri': uri, ...(cookie ? { cookie } : {}) } });
}
async function connect(u: U) {
  const messages: any[] = [];
  const ws: WebSocket = await app.injectWS('/api/ws', { headers: { cookie: u.cookie, origin: ORIGIN } }, { onInit: (s) => s.on('message', (d) => messages.push(JSON.parse(String(d)))) });
  return { ws, messages, has: (pred: (m: any) => boolean) => messages.some(pred) };
}

test('creating a Tank starts a container and opens it; host gets an embed URL with admin credentials', async () => {
  const host = makeUser('h1');
  const id = await openTank(host);
  const spec = orch.containers.get(id)!.spec;
  assert.ok(spec.udpPort >= 59000 && spec.udpPort <= 59002);

  const detail = (await call(host, 'GET', `/tanks/${id}`)).json();
  assert.equal(detail.role, 'host');
  assert.equal(detail.tank.status, 'open');
  const url = new URL(detail.embedUrl);
  assert.equal(url.origin, TANK_ORIGIN);
  assert.equal(url.pathname, `/${id}/`);
  assert.deepEqual([...url.searchParams.keys()], ['ticket'], 'only a one-time ticket in the URL: no username or password');

  const first = await forwardAuth(id, url.pathname + url.search);
  assert.equal(first.statusCode, 302);
  const login = orch.members.get(id)!.get('h1')!;
  assert.equal(login.kind, 'host', 'host is the Neko admin');
  assert.ok(login.password.length >= 32);
  assert.ok(orch.logins.some((l) => l.tankId === id && l.username === 'h1'), 'signed in to Neko from the server');
  const neko = first.cookies.find((c) => c.name === 'NEKO_SESSION')!;
  assert.equal(neko.value, 'session-h1');
  assert.equal(neko.path, `/${id}/`, 'scoped to this Tank, so several open Tanks do not clash');
  assert.ok(neko.httpOnly);
  assert.equal(new URL(first.headers.location as string, 'https://x').search, '', 'redirect carries no credentials');

  const list = (await call(host, 'GET', '/tanks')).json().tanks;
  assert.equal(list[0].id, id);
  await call(host, 'DELETE', `/tanks/${id}`);
});

test('limits: one Tank per host, global cap, ports are reused after closing', async () => {
  const a = makeUser('lim-a');
  const b = makeUser('lim-b');
  const c = makeUser('lim-c');
  const d = makeUser('lim-d');
  const ta = await openTank(a);
  assert.equal((await call(a, 'POST', '/tanks', { name: 'again' })).statusCode, 409);
  const tb = await openTank(b);
  await openTank(c);
  assert.equal((await call(d, 'POST', '/tanks', { name: 'full' })).statusCode, 503, 'global cap of 3');

  const freed = orch.containers.get(ta)!.spec.udpPort;
  await call(a, 'DELETE', `/tanks/${ta}`);
  const td = await openTank(d);
  assert.equal(orch.containers.get(td)!.spec.udpPort, freed, 'freed port reused');
  for (const [u, t] of [[b, tb], [d, td]] as const) await call(u, 'DELETE', `/tanks/${t}`);
  await call(c, 'DELETE', `/tanks/${app.tanks.listFor(c.id)[0]!.id}`);
});

test('a container that fails to start closes the Tank', async () => {
  const host = makeUser('fail');
  orch.failNextStart = true;
  const res = await call(host, 'POST', '/tanks', { name: 'doomed' });
  const id = res.json().tank.id;
  await until(() => app.tanks.get(id)?.status === 'closed');
  assert.equal(app.tanks.get(id)!.close_reason, 'failed to start');
});

test('direct invites: friends only, live notification, accept joins', async () => {
  const host = makeUser('dh');
  const friend = makeUser('df');
  const stranger = makeUser('ds');
  befriend(host, friend);
  const id = await openTank(host);
  const sock = await connect(friend);

  const inv = await call(host, 'POST', `/tanks/${id}/invites`, { userIds: [friend.id, stranger.id] });
  assert.equal(inv.json().invited, 1, 'stranger skipped');
  await until(() => sock.has((m) => m.type === 'tank.invite' && m.invite.tank.id === id));

  assert.equal((await call(stranger, 'GET', `/tanks/${id}`)).statusCode, 404, 'non-member sees 404');
  const inbox = (await call(friend, 'GET', '/tank-invites')).json().invites;
  assert.equal(inbox.length, 1);
  assert.deepEqual((await call(host, 'GET', `/tanks/${id}`)).json().pendingInvitees, [friend.id]);

  const acc = await call(friend, 'POST', `/tank-invites/${inbox[0].id}/accept`);
  assert.equal(acc.json().tankId, id);
  const detail = (await call(friend, 'GET', `/tanks/${id}`)).json();
  assert.equal(detail.role, 'guest');
  assert.equal(new URL(detail.embedUrl).searchParams.get('pwd'), null);
  await signIn(friend, id);
  const login = orch.members.get(id)!.get('df')!;
  assert.equal(login.kind, 'member', 'friends with accounts can be handed control');
  assert.notEqual(login.password, orch.members.get(id)!.get('dh')?.password, 'each person has their own Neko password');
  assert.equal((await call(friend, 'GET', '/tank-invites')).json().invites.length, 0);

  assert.equal((await call(friend, 'DELETE', `/tanks/${id}`)).statusCode, 403, 'guests cannot drain');
  sock.ws.terminate();
  await call(host, 'DELETE', `/tanks/${id}`);
});

test("friends' Tanks: friends see and drop in; strangers can't; host can hide it", async () => {
  const host = makeUser('fth');
  const friend = makeUser('ftf');
  const other = makeUser('fto');
  const stranger = makeUser('fts');
  befriend(host, friend);
  befriend(host, other);
  const sock = await connect(friend);
  const id = await openTank(host);
  await until(() => sock.has((m) => m.type === 'friends.tanks'));

  const list = (await call(friend, 'GET', '/tanks/friends')).json().tanks;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].hostId, host.id);
  assert.equal(list[0].status, 'open');
  assert.equal((await call(stranger, 'GET', '/tanks/friends')).json().tanks.length, 0, 'strangers see nothing');
  assert.equal((await call(host, 'GET', '/tanks/friends')).json().tanks.length, 0, 'host does not see their own');
  assert.equal((await call(stranger, 'POST', `/tanks/${id}/join`)).statusCode, 404, 'strangers cannot join');

  const join = await call(friend, 'POST', `/tanks/${id}/join`);
  assert.equal(join.json().tankId, id);
  assert.equal((await call(friend, 'GET', `/tanks/${id}`)).json().role, 'guest');
  assert.equal((await call(friend, 'GET', '/tanks/friends')).json().tanks.length, 0, 'joined Tanks move to "Your Tanks"');

  assert.equal((await call(friend, 'PATCH', `/tanks/${id}`, { friendsCanJoin: false })).statusCode, 403, 'guests cannot change it');
  assert.equal((await call(host, 'PATCH', `/tanks/${id}`, { friendsCanJoin: false })).statusCode, 200);
  assert.equal((await call(host, 'GET', `/tanks/${id}`)).json().tank.friendsCanJoin, false);
  assert.equal((await call(other, 'GET', '/tanks/friends')).json().tanks.length, 0, 'hidden from friends');
  assert.equal((await call(other, 'POST', `/tanks/${id}/join`)).statusCode, 404, 'hidden Tanks cannot be joined');

  await call(host, 'PATCH', `/tanks/${id}`, { friendsCanJoin: true });
  assert.equal((await call(other, 'GET', '/tanks/friends')).json().tanks.length, 1);
  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal((await call(other, 'GET', '/tanks/friends')).json().tanks.length, 0, 'drained Tanks disappear');
  sock.ws.terminate();
});

test('previews: captured on an interval, visible to members and friends only, gone when drained', async () => {
  const host = makeUser('pvh');
  const friend = makeUser('pvf');
  const stranger = makeUser('pvs');
  befriend(host, friend);
  const id = await openTank(host);
  assert.equal((await call(host, 'GET', `/tanks/${id}/preview`)).statusCode, 404, 'nothing captured yet');

  const before = orch.shots;
  await app.tanks.refreshPreviews();
  assert.equal(orch.shots, before + 1);
  await app.tanks.refreshPreviews();
  assert.equal(orch.shots, before + 1, 'not again before the interval');

  const res = await call(host, 'GET', `/tanks/${id}/preview`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(typeof (await call(host, 'GET', '/tanks')).json().tanks.find((t: any) => t.id === id).previewAt, 'number');
  assert.equal(typeof (await call(friend, 'GET', '/tanks/friends')).json().tanks[0].previewAt, 'number');
  assert.equal((await call(friend, 'GET', `/tanks/${id}/preview`)).statusCode, 200, 'friends can see it');
  assert.equal((await call(stranger, 'GET', `/tanks/${id}/preview`)).statusCode, 404, 'strangers cannot');

  await call(host, 'PATCH', `/tanks/${id}`, { friendsCanJoin: false });
  assert.equal((await call(friend, 'GET', `/tanks/${id}/preview`)).statusCode, 404, 'hidden from friends');

  await app.tanks.refreshPreviews(Date.now() + config.tanks.previewMinutes * 60_000);
  assert.equal(orch.shots, before + 2, 'refreshed after the interval');

  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal((await call(host, 'GET', `/tanks/${id}/preview`)).statusCode, 404, 'gone with the Tank');
});

test('code invites: redeem by existing user, use limits; TANK codes cannot create accounts', async () => {
  const host = makeUser('ch');
  const guest = makeUser('cg');
  const id = await openTank(host);

  const made = await call(host, 'POST', `/tanks/${id}/codes`, { maxUses: 2 });
  assert.equal(made.statusCode, 201);
  const { code, link } = made.json();
  assert.match(code, /^TANK-/);
  assert.equal(link, `${ORIGIN}/join/${code}`);
  assert.equal((await call(guest, 'POST', `/tanks/${id}/codes`, {})).statusCode, 404, 'non-members cannot make codes');

  assert.equal((await call(guest, 'POST', '/tank-codes/redeem', { code })).json().tankId, id);
  assert.equal((await call(guest, 'POST', '/tank-codes/redeem', { code })).statusCode, 200, 'members re-redeem for free');

  // A TANK code is not a sign-up code: permanent accounts only come from admins' FISH codes.
  ensureBootstrapCode(db);
  const reg = await call(null, 'POST', '/auth/register', { username: 'newbie', displayName: 'Newbie', password: 'long enough password', code });
  assert.equal(reg.statusCode, 400, reg.body);
  assert.equal((await call(makeUser('cg2'), 'POST', '/tank-codes/redeem', { code })).statusCode, 200, 'second and last use');

  const late = makeUser('cl');
  assert.equal((await call(late, 'POST', '/tank-codes/redeem', { code })).statusCode, 404, 'used up');
  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal((await call(late, 'POST', '/tank-codes/redeem', { code })).statusCode, 404);
});

test('host can list and revoke invite links; revoked codes stop working everywhere', async () => {
  const host = makeUser('rvh');
  const guest = makeUser('rvg');
  const late = makeUser('rvl');
  const id = await openTank(host);
  const a = (await call(host, 'POST', `/tanks/${id}/codes`, { maxUses: 3 })).json();
  const b = (await call(host, 'POST', `/tanks/${id}/codes`, { maxUses: 1 })).json();
  assert.equal((await call(guest, 'POST', '/tank-codes/redeem', { code: a.code })).statusCode, 200);

  const codes = (await call(host, 'GET', `/tanks/${id}/codes`)).json().codes;
  assert.equal(codes.length, 2);
  const ca = codes.find((c: any) => c.id === a.id);
  assert.equal(ca.hint, a.code.slice(-4));
  assert.equal(ca.uses, 1);
  assert.equal(JSON.stringify(codes).includes(a.code), false, 'full codes are never listed');
  assert.equal((await call(guest, 'GET', `/tanks/${id}/codes`)).statusCode, 403, 'guests cannot list');
  assert.equal((await call(guest, 'DELETE', `/tanks/${id}/codes/${a.id}`)).statusCode, 403, 'guests cannot revoke');
  assert.equal((await call(late, 'DELETE', `/tanks/${id}/codes/${a.id}`)).statusCode, 404, 'non-members get 404');

  assert.equal((await call(host, 'DELETE', `/tanks/${id}/codes/${a.id}`)).statusCode, 200);
  assert.equal((await call(host, 'DELETE', `/tanks/${id}/codes/${a.id}`)).statusCode, 404, 'already revoked');
  assert.equal((await call(late, 'POST', '/tank-codes/redeem', { code: a.code })).statusCode, 404, 'revoked code cannot join');
  assert.equal((await call(guest, 'GET', `/tanks/${id}`)).json().role, 'guest', 'people who joined with it stay');
  assert.deepEqual((await call(host, 'GET', `/tanks/${id}/codes`)).json().codes.map((c: any) => c.id), [b.id]);
  assert.equal((await call(late, 'POST', '/tank-codes/redeem', { code: b.code })).statusCode, 200, 'other links still work');
  assert.equal((await call(host, 'GET', `/tanks/${id}/codes`)).json().codes.length, 0, 'used-up links drop off the list');
  await call(host, 'DELETE', `/tanks/${id}`);
});

test('friends list shows who is in a Tank, naming it only if you could see it yourself', async () => {
  const host = makeUser('ith');
  const viewer = makeUser('itv');
  const watcher = makeUser('itw');
  befriend(watcher, viewer);
  befriend(host, watcher);
  const id = await openTank(host, 'Secret show');
  await call(watcher, 'POST', `/tanks/${id}/join`);
  const sock = await connect(viewer);
  const status = async () => (await call(viewer, 'GET', '/friends')).json().friends.find((f: any) => f.id === watcher.id).inTank;

  assert.equal(await status(), null, 'not watching yet');
  assert.ok(app.tanks.join(id, watcher.id));
  await until(() => sock.has((m) => m.type === 'friends.activity' && m.userId === watcher.id));
  assert.deepEqual(await status(), { id: null, name: null }, "host isn't the viewer's friend: just 'in a Tank'");

  befriend(host, viewer);
  assert.deepEqual(await status(), { id, name: 'Secret show' }, "open to the host's friends: named");
  await call(host, 'PATCH', `/tanks/${id}`, { friendsCanJoin: false });
  assert.deepEqual(await status(), { id: null, name: null }, 'hidden again');

  const before = sock.messages.length;
  app.tanks.leave(id, watcher.id);
  await until(() => sock.messages.slice(before).some((m) => m.type === 'friends.activity'));
  assert.equal(await status(), null, 'stopped watching');

  assert.ok(app.tanks.join(id, watcher.id));
  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal(await status(), null, 'Tank drained');
  sock.ws.terminate();
});

test('tank-origin forward auth: ticket → cookie → allowed; non-members, tampering, leaving and closing are denied', async () => {
  const host = makeUser('ah');
  const guest = makeUser('ag');
  befriend(host, guest);
  const id = await openTank(host);
  await call(host, 'POST', `/tanks/${id}/invites`, { userIds: [guest.id] });
  const inviteId = (await call(guest, 'GET', '/tank-invites')).json().invites[0].id;
  await call(guest, 'POST', `/tank-invites/${inviteId}/accept`);

  const embed = new URL((await call(guest, 'GET', `/tanks/${id}`)).json().embedUrl);
  const first = await forwardAuth(id, embed.pathname + embed.search);
  assert.equal(first.statusCode, 302);
  const loc = new URL(first.headers.location as string, 'https://x');
  assert.equal(loc.search, '', 'ticket stripped, no credentials added');
  assert.ok(first.cookies.find((c) => c.name === 'NEKO_SESSION'));

  // Tickets work once: a replay without the pass is refused; with it, just redirected.
  assert.equal((await forwardAuth(id, embed.pathname + embed.search)).statusCode, 401, 'ticket reuse refused');
  const pass = first.cookies.find((c) => c.name === 'ftt')!;
  assert.equal(pass.path, `/${id}/`);
  assert.ok(pass.httpOnly);
  const cookie = `ftt=${pass.value}`;
  const again = await forwardAuth(id, embed.pathname + embed.search, cookie);
  assert.equal(again.statusCode, 302, 'reload of the first URL with a pass is fine');
  assert.equal(again.cookies.length, 0, 'no new Neko sign-in');

  assert.equal((await forwardAuth(id, `/${id}/api/ws`, cookie)).statusCode, 204);
  assert.equal((await forwardAuth(id, `/${id}/`)).statusCode, 401, 'no cookie');
  assert.equal((await forwardAuth(id, `/${id}/`, `ftt=${pass.value.slice(0, -2)}xx`)).statusCode, 401, 'tampered');

  const other = await openTank(makeUser('ah2'));
  assert.equal((await forwardAuth(other, `/${other}/`, cookie)).statusCode, 401, 'pass is bound to one Tank');

  await call(guest, 'POST', `/tanks/${id}/leave`);
  assert.equal((await forwardAuth(id, `/${id}/`, cookie)).statusCode, 401, 'left → denied');

  const hostEmbed = new URL((await call(host, 'GET', `/tanks/${id}`)).json().embedUrl);
  const hostCookie = (await forwardAuth(id, hostEmbed.pathname + hostEmbed.search)).cookies.find((c) => c.name === 'ftt')!;
  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal((await forwardAuth(id, `/${id}/`, `ftt=${hostCookie.value}`)).statusCode, 401, 'closed → denied');
  await app.tanks.close(other, 'test');
});

test('viewers keep a Tank alive; idle and expired Tanks are reaped', async () => {
  const host = makeUser('rh');
  const id = await openTank(host);
  const sock = await connect(host);
  sock.ws.send(JSON.stringify({ type: 'tank.join', tankId: id }));
  await until(() => app.tanks.viewersOf(id).includes(host.id));
  assert.equal((await call(host, 'GET', `/tanks/${id}`)).json().members[0].watching, true);

  const later = Date.now() + 60 * 60_000;
  await app.tanks.reap(later);
  assert.equal(app.tanks.get(id)!.status, 'open', 'watched → stays open');

  sock.ws.send(JSON.stringify({ type: 'tank.leave' }));
  await until(() => app.tanks.viewersOf(id).length === 0);
  await app.tanks.reap(Date.now() + 16 * 60_000);
  assert.equal(app.tanks.get(id)!.close_reason, 'idle');
  assert.ok(orch.destroyed.includes(id));
  await until(() => sock.has((m) => m.type === 'tank.closed' && m.tankId === id && m.reason === 'idle'));
  sock.ws.terminate();

  const id2 = await openTank(host);
  await app.tanks.reap(Date.now() + 9 * 60 * 60_000);
  assert.equal(app.tanks.get(id2)!.close_reason, 'time limit');
});

test('reconcile removes orphans, closes Tanks whose container vanished, and recovers credentials', async () => {
  orch.containers.set('11111111-1111-4111-8111-111111111111', { spec: { id: 'x', udpPort: 1, name: 'orphan', apiToken: 't' }, running: true });
  const host = makeUser('rc');
  const id = await openTank(host);
  const host2 = makeUser('rc2');
  const id2 = await openTank(host2);
  orch.containers.delete(id2);

  await app.tanks.reconcile();
  assert.ok(orch.destroyed.includes('11111111-1111-4111-8111-111111111111'), 'orphan removed');
  assert.equal(app.tanks.get(id2)!.close_reason, 'container missing');
  assert.equal(app.tanks.get(id)!.status, 'open');

  // Simulate an app restart: a fresh app on the same DB has no in-memory passwords.
  const app2 = await buildApp({ config, db, orchestrator: orch }, { logger: false });
  assert.equal(app2.tanks.credentialsFor(id), null);
  await app2.tanks.reconcile();
  const spec = orch.containers.get(id)!.spec;
  assert.deepEqual(app2.tanks.credentialsFor(id), { apiToken: spec.apiToken, recordable: false });
  await app2.close();
  await app.tanks.close(id, 'test');
});

test('draining notifies members; admins can close any Tank; non-members get 404', async () => {
  const host = makeUser('xh');
  const stranger = makeUser('xs');
  const id = await openTank(host);
  const sock = await connect(host);
  assert.equal((await call(stranger, 'DELETE', `/tanks/${id}`)).statusCode, 404);
  assert.equal((await call(host, 'DELETE', `/tanks/${id}`)).statusCode, 200);
  await until(() => sock.has((m) => m.type === 'tank.closed' && m.reason === 'drained by host'));
  assert.equal((await call(host, 'GET', `/tanks/${id}`)).json().tank.status, 'closed');
  sock.ws.terminate();

  const id2 = await openTank(host);
  const admin = makeUser('xa');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  admin.cookie = `${SESSION_COOKIE}=${createSession(db, admin.id, 30)}`;
  assert.equal((await call(admin, 'DELETE', `/tanks/${id2}`)).statusCode, 200);
  assert.equal(app.tanks.get(id2)!.close_reason, 'closed by an admin');
});

test('host can remove a guest: membership gone, Neko session disconnected, guest told, access denied', async () => {
  const host = makeUser('kh');
  const guest = makeUser('kg');
  befriend(host, guest);
  const id = await openTank(host);
  await call(host, 'POST', `/tanks/${id}/invites`, { userIds: [guest.id] });
  await call(guest, 'POST', `/tank-invites/${(await call(guest, 'GET', '/tank-invites')).json().invites[0].id}/accept`);

  const embed = new URL((await call(guest, 'GET', `/tanks/${id}`)).json().embedUrl);
  const pass = (await forwardAuth(id, embed.pathname + embed.search)).cookies.find((c) => c.name === 'ftt')!;
  const sock = await connect(guest);

  assert.equal((await call(guest, 'DELETE', `/tanks/${id}/members/${host.id}`)).statusCode, 403, 'guests cannot remove');
  assert.equal((await call(host, 'DELETE', `/tanks/${id}/members/${host.id}`)).statusCode, 400, 'host cannot remove self');
  assert.equal((await call(host, 'DELETE', `/tanks/${id}/members/${guest.id}`)).statusCode, 200);

  assert.equal((await call(guest, 'GET', `/tanks/${id}`)).statusCode, 404);
  assert.equal((await forwardAuth(id, `/${id}/`, `ftt=${pass.value}`)).statusCode, 401);
  assert.ok(orch.removed.some((x) => x.tankId === id && x.username === 'kg'), 'their Neko login is deleted');
  await until(() => sock.has((m) => m.type === 'tank.removed' && m.tankId === id));
  sock.ws.terminate();
  await call(host, 'DELETE', `/tanks/${id}`);
});

test('admin dashboard: admins only, shows live Tanks with stats; disabling evicts the user everywhere', async () => {
  const admin = makeUser('adm');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const bad = makeUser('bad');
  const other = makeUser('oth');
  befriend(bad, other);

  assert.equal((await call(bad, 'GET', '/admin/overview')).statusCode, 403);

  const badTank = await openTank(bad, 'Bad host');
  const otherTank = await openTank(other, 'Other host');
  await call(other, 'POST', `/tanks/${otherTank}/invites`, { userIds: [bad.id] });
  await call(bad, 'POST', `/tank-invites/${(await call(bad, 'GET', '/tank-invites')).json().invites[0].id}/accept`);
  const embed = new URL((await call(bad, 'GET', `/tanks/${otherTank}`)).json().embedUrl);
  const pass = (await forwardAuth(otherTank, embed.pathname + embed.search)).cookies.find((c) => c.name === 'ftt')!;

  const overview = (await call(admin, 'GET', '/admin/overview')).json();
  const row = overview.tanks.find((t: any) => t.id === badTank);
  assert.equal(row.hostUsername, 'bad');
  assert.deepEqual(row.stats, { cpuPercent: 42, memoryMb: 512 });
  assert.equal(overview.users.find((u: any) => u.username === 'bad').disabled, false);

  assert.equal((await call(admin, 'POST', `/admin/users/${admin.id}/disable`)).statusCode, 400, 'cannot disable self');
  assert.equal((await call(admin, 'POST', `/admin/users/${bad.id}/disable`)).statusCode, 200);

  assert.equal((await call(bad, 'GET', '/me')).statusCode, 401, 'signed out');
  assert.equal(app.tanks.get(badTank)!.close_reason, 'host account disabled');
  assert.equal(app.tanks.role(otherTank, bad.id), null, 'removed from other Tank');
  assert.equal((await forwardAuth(otherTank, `/${otherTank}/`, `ftt=${pass.value}`)).statusCode, 401);
  assert.ok(orch.removed.some((d) => d.tankId === otherTank && d.username === 'bad'));

  assert.equal((await call(admin, 'POST', `/admin/users/${bad.id}/enable`)).statusCode, 200);
  assert.equal(overview.limits.maxTanks, 3);
  await call(other, 'DELETE', `/tanks/${otherTank}`);
});

test('invite links get link-preview tags and a public screenshot for valid codes only', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'fishtank-web-'));
  writeFileSync(join(dist, 'index.html'), '<html><head><title>FishTank</title></head><body></body></html>');
  const sdb = openDb(':memory:');
  const sorch = new FakeOrchestrator();
  const sapp = await buildApp({ config: { ...config, webDist: dist }, db: sdb, orchestrator: sorch }, { logger: false });
  try {
    const id = randomUUID();
    sdb.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'sh', 'Sam <b>', 'x', ?)").run(id, Date.now());
    const host: U = { id, username: 'sh', cookie: `${SESSION_COOKIE}=${createSession(sdb, id, 30)}` };
    const tank = sapp.tanks.create(host.id, 'Movie "night" <script>');
    await until(() => sapp.tanks.get(tank.id)?.status === 'open');
    const { code } = sapp.tanks.createCode(tank.id, host.id, { maxUses: 1 });

    const page = await sapp.inject({ method: 'GET', url: `/join/${code}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<meta property="og:title" content="Join “Movie &#34;night&#34; &#60;script&#62;” on FishTank" \/>/);
    assert.match(page.body, /Sam &#60;b&#62; is hosting a watch party/);
    assert.equal(sorch.shots, 1, 'captured on demand for the first share');
    const img = page.body.match(/property="og:image" content="([^"]+)"/)![1]!;
    assert.ok(img.startsWith(`${config.publicUrl}/api/tank-codes/${code}/preview.jpg?v=`));

    const jpeg = await sapp.inject({ method: 'GET', url: new URL(img).pathname });
    assert.equal(jpeg.statusCode, 200, 'no login needed');
    assert.equal(jpeg.headers['content-type'], 'image/jpeg');
    assert.equal((await sapp.inject({ method: 'GET', url: '/api/tank-codes/TANK-NOPE-NOPE/preview.jpg' })).statusCode, 404);

    const bad = await sapp.inject({ method: 'GET', url: '/join/TANK-NOPE-NOPE' });
    assert.equal(bad.statusCode, 200);
    assert.match(bad.body, /og:title" content="FishTank"/);
    assert.doesNotMatch(bad.body, /og:image/);

    await sapp.tanks.close(tank.id, 'drained by host');
    assert.equal((await sapp.inject({ method: 'GET', url: new URL(img).pathname })).statusCode, 404, 'gone when drained');
    assert.doesNotMatch((await sapp.inject({ method: 'GET', url: `/join/${code}` })).body, /Movie/);
  } finally {
    await sapp.close();
    sdb.close();
  }
});

test('legacy Tanks (shared Neko passwords) keep working after an upgrade', async () => {
  const host = makeUser('lgh');
  const friend = makeUser('lgf');
  befriend(host, friend);
  const id = await openTank(host);
  const c = orch.containers.get(id)!;
  c.legacy = { userPassword: 'shared-user', adminPassword: 'shared-admin', apiToken: c.spec.apiToken };
  const app2 = await buildApp({ config, db, orchestrator: orch }, { logger: false });
  try {
    await app2.tanks.reconcile();
    // The app's URL never has the password; the Tank-origin redirect does (old Neko logs in from the URL).
    const redirectFor = async (u: U) => {
      const embed = new URL((await app2.inject({ method: 'GET', url: `/api/tanks/${id}`, headers: { origin: ORIGIN, cookie: u.cookie } })).json().embedUrl);
      assert.equal(embed.searchParams.get('pwd'), null);
      const res = await app2.inject({ method: 'GET', url: `/auth/tank/${id}`, headers: { 'x-forwarded-uri': embed.pathname + embed.search } });
      assert.equal(res.statusCode, 302);
      return new URL(res.headers.location as string, 'https://x').searchParams;
    };
    assert.equal((await redirectFor(host)).get('pwd'), 'shared-admin');
    await app2.tanks.joinAsFriend(id, friend.id);
    assert.equal((await redirectFor(friend)).get('pwd'), 'shared-user');
  } finally {
    await app2.close();
  }
  await app.tanks.close(id, 'test');
});

test('guests: TANK links make watch-only temporary guests, wiped on leave, disconnect and drain; admins see who invited them', async () => {
  const admin = makeUser('gadm');
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  const host = makeUser('gh');
  const id = await openTank(host, 'Guest night');
  const { code } = (await call(host, 'POST', `/tanks/${id}/codes`, { maxUses: 3 })).json();

  assert.deepEqual((await call(null, 'GET', `/tank-codes/${code}`)).json(), { tankName: 'Guest night', host: 'gh', recording: false });
  assert.equal((await call(null, 'GET', '/tank-codes/TANK-NOPE-NOPE')).statusCode, 404);
  assert.equal((await call(host, 'POST', `/tank-codes/${code}/guest`)).statusCode, 409, 'signed-in people join as themselves');

  const join = async (): Promise<U> => {
    const res = await call(null, 'POST', `/tank-codes/${code}/guest`);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().tankId, id);
    const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user;
    return { id: me.id, username: me.username, cookie };
  };

  // 1) Joins with a random name, watch-only Neko login.
  const g1 = await join();
  const me = (await call(g1, 'GET', '/me')).json().user;
  assert.equal(me.guestTankId, id);
  assert.match(me.displayName, /^[A-Z][a-z]+ [A-Z][a-z]+ \d\d$/);
  assert.match(me.username, /^guest-/);
  const detail = (await call(g1, 'GET', `/tanks/${id}`)).json();
  assert.equal(detail.role, 'guest');
  assert.equal((await signIn(g1, id)).statusCode, 302);
  assert.equal(orch.members.get(id)!.get(g1.username)!.kind, 'guest', 'guests can never take control');
  assert.equal((await call(host, 'GET', `/tanks/${id}`)).json().members.find((m: any) => m.id === g1.id).isGuest, true);

  // Locked to their Tank: nothing else in the API.
  for (const [m, url] of [['GET', '/friends'], ['GET', '/tanks'], ['POST', '/tanks'], ['GET', '/tanks/friends'], ['GET', '/tank-invites'], ['GET', '/account/security'], ['POST', '/registration-codes'], ['GET', '/registration-codes']] as const) {
    assert.equal((await call(g1, m, url, m === 'POST' ? {} : undefined)).statusCode, 403, `${m} ${url}`);
  }
  assert.equal((await call(g1, 'POST', '/tank-codes/redeem', { code })).statusCode, 403);
  assert.equal((await call(null, 'POST', '/auth/login', { username: g1.username, password: '!' })).statusCode, 401, 'no logging in as a guest');
  assert.equal((await call(host, 'POST', '/friends/requests', { username: g1.username })).statusCode, 404, 'guests cannot be friended');

  // Admin panel: the guest, their Tank, who invited them, and the log.
  let overview = (await call(admin, 'GET', '/admin/overview')).json();
  const row = overview.guests.find((g: any) => g.id === g1.id);
  assert.equal(row.invitedBy, 'gh');
  assert.equal(row.guestTankName, 'Guest night');
  assert.equal(overview.users.some((u: any) => u.id === g1.id), false, 'guests are listed apart from accounts');

  // Leaving wipes them at once.
  const sock = await connect(g1);
  assert.equal((await call(g1, 'POST', `/tanks/${id}/leave`)).statusCode, 200);
  assert.equal((await call(g1, 'GET', '/me')).statusCode, 401);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(g1.id), undefined);
  assert.ok(orch.removed.some((r) => r.tankId === id && r.username === g1.username));
  await until(() => sock.ws.readyState === sock.ws.CLOSED);

  // 2) Never connects (or closes their tab): wiped after the grace period.
  const g2 = await join();
  const now = Date.now();
  await app.tanks.sweepGuests(now);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(g2.id), 'kept during the grace period');
  await app.tanks.sweepGuests(now + GUEST_GRACE_MS);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(g2.id), undefined, 'wiped after it');

  // 3) Connected guests stay; draining the Tank wipes them. The code is now used up.
  const g3 = await join();
  const s3 = await connect(g3);
  await app.tanks.sweepGuests(now);
  await app.tanks.sweepGuests(now + GUEST_GRACE_MS);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(g3.id), 'online guests are kept');
  assert.equal((await call(null, 'POST', `/tank-codes/${code}/guest`)).statusCode, 404, 'each guest uses up one use');
  await call(host, 'DELETE', `/tanks/${id}`);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(g3.id), undefined);
  await until(() => s3.ws.readyState === s3.ws.CLOSED);

  // A guest left behind on a closed Tank (app stopped mid-close) is swept up.
  const orphanId = randomUUID();
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at, guest_tank_id) VALUES (?, 'guest-orphan', 'Orphan', '!', ?, ?)").run(orphanId, Date.now(), id);
  await app.tanks.sweepGuests();
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(orphanId), undefined);

  overview = (await call(admin, 'GET', '/admin/overview')).json();
  assert.equal(overview.guests.length, 0);
  const logs = overview.invites.filter((i: any) => i.kind === 'guest' && i.tankName === 'Guest night');
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l: any) => l.invitedByName === 'gh' && l.endedAt));
  assert.deepEqual(logs.map((l: any) => l.endReason).sort(), ['Tank drained', 'disconnected', 'left']);
});

test("avatars show in Neko's member list through signed links that work without a login", async () => {
  const host = makeUser('avh');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const up = await app.inject({ method: 'PUT', url: '/api/account/avatar', payload: { image: PNG.toString('base64') }, headers: { origin: ORIGIN, cookie: host.cookie } });
  assert.equal(up.statusCode, 200, up.body);
  const id = await openTank(host);
  await signIn(host, id);

  const link = orch.members.get(id)!.get('avh')!.avatarUrl!;
  const url = new URL(link);
  assert.equal(url.origin, ORIGIN, 'absolute URL on the app origin');
  const img = await app.inject({ method: 'GET', url: url.pathname + url.search });
  assert.equal(img.statusCode, 200, 'no cookie needed');
  assert.equal(img.headers['content-type'], 'image/png');

  const forged = new URL(link);
  forged.searchParams.set('sig', 'x'.repeat(32));
  assert.equal((await app.inject({ method: 'GET', url: forged.pathname + forged.search })).statusCode, 401);
  const other = makeUser('avo');
  assert.equal((await app.inject({ method: 'GET', url: `/api/avatars/${other.id}${url.search}` })).statusCode, 401, 'only unlocks that user');
  assert.equal((await app.inject({ method: 'GET', url: url.pathname })).statusCode, 401, 'unsigned still needs a login');

  // Changing the avatar updates the live Neko profile; the old link stops working.
  await new Promise((r) => setTimeout(r, 2));
  await app.inject({ method: 'PUT', url: '/api/account/avatar', payload: { image: PNG.toString('base64') }, headers: { origin: ORIGIN, cookie: host.cookie } });
  await until(() => orch.updates.some((m) => m.username === 'avh' && m.avatarUrl !== link));
  assert.equal((await app.inject({ method: 'GET', url: url.pathname + url.search })).statusCode, 401, 'old link revoked');
  assert.equal(orch.members.get(id)!.get('avh')!.kind, 'host', 'permissions unchanged by the update');

  await app.inject({ method: 'DELETE', url: '/api/account/avatar', headers: { origin: ORIGIN, cookie: host.cookie } });
  await until(() => orch.updates.some((m) => m.username === 'avh' && m.avatarUrl === null));
  await call(host, 'DELETE', `/tanks/${id}`);
});
