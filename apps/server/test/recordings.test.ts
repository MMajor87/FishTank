import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { broadcastPipeline, loadConfig, type Config } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { inCidr, mp4DurationMs } from '../src/recordings.ts';
import { withFishTankPolicies } from '../src/startpage.ts';
import { buildTankPlayback } from '../src/tankplayback.ts';
import { SESSION_COOKIE, createSession } from '../src/sessions.ts';
import { FakeOrchestrator } from './fake-orchestrator.ts';

const ORIGIN = 'http://localhost:3000';
const TANK_IP = '10.88.2.130';
const HOUR = 3_600_000;

let app: FastifyInstance;
let db: DB;
let orch: FakeOrchestrator;
let config: Config;
let dir: string;

interface U {
  id: string;
  username: string;
  cookie: string;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fishtank-rec-'));
  mkdirSync(join(dir, 'raw'));
  mkdirSync(join(dir, 'ready'));
  db = openDb(':memory:');
  orch = new FakeOrchestrator();
  orch.recordable = true;
  const base = loadConfig({ RECORDING_ENABLED: 'true' });
  config = {
    ...base,
    appOrigins: [ORIGIN],
    publicUrl: ORIGIN,
    tanks: { ...base.tanks, maxTanks: 10, maxPerHost: 1, portRange: [59000, 59009] },
    // In tests the recorder's calls come from inject's default address.
    recording: { ...base.recording, dir, minFreeGb: 0, recorderIp: '127.0.0.1' },
  };
  app = await buildApp(
    { config, db, orchestrator: orch },
    { logger: false, recordingTimings: { readyTimeoutMs: 300, stallMs: HOUR }, recorderFetch: fakeRecorder as typeof fetch },
  );
  simulateRecorder();
});
after(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The recorder's playback server (clips). Like the real one, it asks the app's auth hook first. */
const recorderCalls: URL[] = [];
let recorderSpans: Array<{ start: string; duration: number }> | null = null;
let recorderFails = false;
async function fakeRecorder(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  recorderCalls.push(url);
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
  const [user, password] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
  const hook = await app.inject({
    method: 'POST',
    url: '/auth/recorder',
    payload: { action: 'playback', path: url.searchParams.get('path'), query: '', ip: '10.88.2.2', protocol: '', user, password },
  });
  if (hook.statusCode !== 204) return new Response('denied', { status: 401 });
  if (url.pathname === '/list') return Response.json(recorderSpans ?? [{ start: new Date(Date.now() - 90_000).toISOString(), duration: 90 }]);
  if (recorderFails) return new Response('boom', { status: 500 });
  return new Response(new Uint8Array(fakeMp4(Math.round(Number(url.searchParams.get("duration")) * 1000))));
}

/** The recorder: when Neko starts pushing, ask the app (auth hook) and report the stream as up. */
function simulateRecorder() {
  orch.onBroadcastStart = (_tankId, url) =>
    setImmediate(async () => {
      const u = new URL(url.replace(/^rtmp:/, 'http:'));
      const path = u.pathname.slice(1);
      if ((await publish(path, u.search.slice(1))).statusCode === 204) await event('ready', path);
    });
}
function publish(path: string, query: string, ip = TANK_IP, extra: object = {}) {
  return app.inject({
    method: 'POST',
    url: '/auth/recorder',
    payload: { action: 'publish', path, query, ip, protocol: 'rtmp', user: '', password: '', token: '', id: null, ...extra },
  });
}
function event(ev: 'ready' | 'notready', path: string) {
  return app.inject({ method: 'POST', url: '/auth/recorder/event', payload: { event: ev, path } });
}

function makeUser(username: string, role: 'admin' | 'member' = 'member', guestTankId: string | null = null): U {
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, role, created_at, guest_tank_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    username,
    username,
    'x',
    role,
    Date.now(),
    guestTankId,
  );
  return { id, username, cookie: `${SESSION_COOKIE}=${createSession(db, id, 30)}` };
}
function call(u: U | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: object) {
  return app.inject({ method, url: `/api${url}`, payload, headers: { origin: ORIGIN, ...(u ? { cookie: u.cookie } : {}), ...headers } });
}
async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function openTank(host: U, ...members: U[]): Promise<string> {
  const tank = app.tanks.create(host.id, `Tank of ${host.username}`);
  await until(() => app.tanks.get(tank.id)?.status === 'open');
  for (const m of members) {
    db.prepare("INSERT INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'guest', ?)").run(tank.id, m.id, Date.now());
  }
  return tank.id;
}
/** The URL (with key) Neko was last told to push this Tank to. */
const lastUrl = (tankId: string) => [...orch.broadcastLog].reverse().find((b) => b.tankId === tankId && b.op === 'start')!.url!;

/** A minimal MP4 the way the remux writes it: ftyp, moov (with mvhd) first, then mdat. */
function fakeMp4(durationMs: number, payload = 4000): Buffer {
  const box = (type: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + body.length);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(durationMs, 16); // duration
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(payload, 7))]);
}
/** What the recorder leaves behind once a part is remuxed. */
function writePart(id: string, name: string, durationMs: number) {
  mkdirSync(join(dir, 'ready', id), { recursive: true });
  writeFileSync(join(dir, 'ready', id, `${name}.mp4`), fakeMp4(durationMs));
}

test('config: the broadcast pipeline is only set when recording is on, and plays in browsers', () => {
  assert.equal(loadConfig({}).tanks.broadcastPipeline, null);
  assert.equal(loadConfig({}).recording.enabled, false);
  const p = loadConfig({ RECORDING_ENABLED: 'true', TANK_SCREEN: '1920x1080@60', RECORDING_PRESET: 'bogus; rm -rf' }).tanks.broadcastPipeline!;
  assert.match(p, /format=I420/);
  assert.match(p, /profile=high/);
  assert.match(p, /framerate=60\/1/);
  assert.match(p, /key-int-max=120/, 'a keyframe every 2 s');
  assert.match(p, /speed-preset=veryfast/, 'unknown presets fall back');
  assert.match(p, /location='\{url\} live=1'/);
  assert.equal(broadcastPipeline({ fps: 30, videoKbps: 2500, audioKbps: 128, preset: 'veryfast' }).includes('bitrate=128000'), true);
  assert.equal(loadConfig({ RECORDING_KEEP_DAYS: 'abc' }).recording.keepDays, 7);
});

test('only an admin who is in the Tank can start recording, once at a time; everyone in it sees it', async () => {
  const admin = makeUser('rec-admin', 'admin');
  const host = makeUser('rec-host');
  const member = makeUser('rec-member');
  const outsiderAdmin = makeUser('rec-admin2', 'admin');
  const tankId = await openTank(host, admin, member);
  const guest = makeUser('rec-guest', 'member', tankId);
  db.prepare("INSERT INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'guest', ?)").run(tankId, guest.id, Date.now());

  assert.equal((await call(member, 'POST', `/tanks/${tankId}/recording`)).statusCode, 403, 'members can not');
  assert.equal((await call(host, 'POST', `/tanks/${tankId}/recording`)).statusCode, 403, 'hosts can not (unless admin)');
  assert.equal((await call(guest, 'POST', `/tanks/${tankId}/recording`)).statusCode, 403, 'guests can not');
  assert.equal((await call(outsiderAdmin, 'POST', `/tanks/${tankId}/recording`)).statusCode, 404, 'admins must be in the Tank');

  const before = (await call(member, 'GET', `/tanks/${tankId}`)).json();
  assert.deepEqual(before.recording, {
    canRecord: false,
    supported: true,
    active: null,
    maxHours: 8,
    keepDays: 7,
    canShare: true,
    canClip: true,
    clipSeconds: 60,
    tankUrl: 'http://10.88.2.2:3001/',
    shared: [],
  });

  const started = await call(admin, 'POST', `/tanks/${tankId}/recording`);
  assert.equal(started.statusCode, 201, started.body);
  const recId = started.json().recording.id as string;
  assert.ok(lastUrl(tankId).startsWith(`rtmp://10.88.2.5:1935/${recId}?key=`));
  assert.equal((await call(admin, 'POST', `/tanks/${tankId}/recording`)).statusCode, 409, 'one at a time');

  const seen = (await call(member, 'GET', `/tanks/${tankId}`)).json();
  assert.equal(seen.recording.active.id, recId);
  assert.equal(seen.recording.active.startedBy, 'rec-admin');
  assert.equal((await call(guest, 'GET', `/tanks/${tankId}`)).json().recording.active.id, recId, 'guests are told too');
  assert.equal((await call(admin, 'GET', `/tanks/${tankId}`)).json().recording.canRecord, true);
  assert.equal((await call(host, 'GET', '/tanks')).json().tanks.find((t: { id: string }) => t.id === tankId).recording, true);
  const { code } = app.tanks.createCode(tankId, host.id, { maxUses: 1 });
  assert.equal((await call(null, 'GET', `/tank-codes/${code}`)).json().recording, true, 'the guest join page warns');
  assert.equal(((await call(admin, 'GET', '/recordings')).json().recordings as Array<{ id: string; status: string }>).find((r) => r.id === recId)?.status, 'recording');

  assert.equal((await call(member, 'DELETE', `/tanks/${tankId}/recording`)).statusCode, 403);
  assert.equal((await call(outsiderAdmin, 'DELETE', `/tanks/${tankId}/recording`)).statusCode, 200, 'any admin can stop');
  assert.equal(app.recordings.get(recId)!.status, 'processing');
  assert.equal(orch.broadcasts.has(tankId), false);
  assert.equal((await call(outsiderAdmin, 'DELETE', `/tanks/${tankId}/recording`)).statusCode, 404);
  await app.tanks.close(tankId, 'test');
});

test('the recorder hook accepts only a live recording, its own key, from a Tank address, from the recorder', async () => {
  const admin = makeUser('auth-admin', 'admin');
  const tankId = await openTank(admin);
  const recId = (await call(admin, 'POST', `/tanks/${tankId}/recording`)).json().recording.id as string;
  const query = new URL(lastUrl(tankId).replace(/^rtmp:/, 'http:')).search.slice(1);

  assert.equal((await publish(recId, query)).statusCode, 204);
  assert.equal((await publish(recId, 'key=wrong')).statusCode, 403, 'wrong key');
  assert.equal((await publish(recId, '')).statusCode, 403, 'no key');
  assert.equal((await publish(randomUUID(), query)).statusCode, 403, 'other path');
  assert.equal((await publish(recId, query, '10.88.2.3')).statusCode, 403, 'not from the Tank range (e.g. Caddy)');
  assert.equal((await publish(recId, query, '192.168.1.20')).statusCode, 403, 'not from the Tank network');
  assert.equal((await publish(recId, query, TANK_IP, { action: 'read' })).statusCode, 403, 'nobody may read');
  assert.equal((await publish(recId, query, TANK_IP, { protocol: 'rtsp' })).statusCode, 403);
  const stranger = await app.inject({
    method: 'POST',
    url: '/auth/recorder',
    remoteAddress: '10.88.2.200',
    payload: { action: 'publish', path: recId, query, ip: TANK_IP, protocol: 'rtmp' },
  });
  assert.equal(stranger.statusCode, 404, 'only the recorder may ask');
  const strangerEvent = await app.inject({ method: 'POST', url: '/auth/recorder/event', remoteAddress: '10.88.2.200', payload: { event: 'notready', path: recId } });
  assert.equal(strangerEvent.statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/recorder/event', payload: { event: 'x', path: recId } })).statusCode, 400);

  await app.tanks.close(tankId, 'test');
  assert.equal((await publish(recId, query)).statusCode, 403, 'ended recordings are refused');
  assert.ok(inCidr('::ffff:10.88.2.129', '10.88.2.128/25'));
  assert.ok(!inCidr('10.88.2.127', '10.88.2.128/25'));
  assert.ok(!inCidr('nonsense', '10.88.2.128/25'));
});

test('draining a Tank stops its recording before the container goes; the files become a playable recording', async () => {
  const admin = makeUser('drain-admin', 'admin');
  const viewer = makeUser('drain-viewer'); // not in the Tank: still allowed to watch
  const tankId = await openTank(admin);
  const recId = (await call(admin, 'POST', `/tanks/${tankId}/recording`)).json().recording.id as string;
  const t0 = app.recordings.get(recId)!.started_at;

  orch.destroyed.length = 0;
  const stopsBefore = orch.broadcastLog.filter((b) => b.op === 'stop' && b.tankId === tankId).length;
  const destroyedAtStop: number[] = [];
  const realStop = orch.stopBroadcast.bind(orch);
  orch.stopBroadcast = async (id: string) => {
    destroyedAtStop.push(orch.destroyed.length);
    return realStop(id);
  };
  assert.equal((await call(admin, 'DELETE', `/tanks/${tankId}`)).statusCode, 200);
  orch.stopBroadcast = realStop;
  assert.equal(orch.broadcastLog.filter((b) => b.op === 'stop' && b.tankId === tankId).length, stopsBefore + 1);
  assert.deepEqual(destroyedAtStop, [0], 'broadcast stopped while the container still existed');
  assert.deepEqual(orch.destroyed, [tankId]);

  const row = app.recordings.get(recId)!;
  assert.equal(row.status, 'processing');
  assert.ok(Math.abs(row.expires_at! - (row.ended_at! + 7 * 24 * HOUR)) < 5, '7 days from the END');
  assert.ok(row.started_at === t0);

  // Recorder still remuxing: raw segment present → stays processing.
  mkdirSync(join(dir, 'raw', recId), { recursive: true });
  writeFileSync(join(dir, 'raw', recId, 'seg.mp4'), 'x');
  writePart(recId, '2026-11-17_20-00-00-000000_-0600', 90_500);
  await app.recordings.tick();
  assert.equal(app.recordings.get(recId)!.status, 'processing');
  rmSync(join(dir, 'raw', recId), { recursive: true });
  writePart(recId, '2026-11-17_20-05-00-000000_-0600', 30_000);
  await app.recordings.tick();
  const ready = app.recordings.get(recId)!;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.duration_ms, 120_500);

  const list = (await call(viewer, 'GET', '/recordings')).json();
  const item = list.recordings.find((r: { id: string }) => r.id === recId);
  assert.equal(item.parts.length, 2);
  assert.equal(item.parts[0].durationMs, 90_500, 'parts in time order');
  assert.equal(list.storage, null, 'disk use is for admins');
  assert.ok((await call(admin, 'GET', '/recordings')).json().storage.freeBytes > 0);

  // Playback with Range.
  const size = fakeMp4(0).length;
  const full = await call(viewer, 'GET', `/recordings/${recId}/video`);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['cache-control'], 'private, no-store');
  assert.equal(full.rawPayload.length, size);
  const part = await call(viewer, 'GET', `/recordings/${recId}/video?part=0`, { range: 'bytes=20-27' });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 20-27/${size}`);
  assert.equal(part.rawPayload.toString('latin1'), String.fromCharCode(0, 0, 0, 116) + 'moov');
  const tail = await call(viewer, 'GET', `/recordings/${recId}/video`, { range: 'bytes=-10' });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.headers['content-range'], `bytes ${size - 10}-${size - 1}/${size}`);
  const open = await call(viewer, 'GET', `/recordings/${recId}/video`, { range: `bytes=${size - 4}-` });
  assert.equal(open.rawPayload.length, 4);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video`, { range: `bytes=${size}-` })).statusCode, 416);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video`, { range: 'bytes=abc' })).statusCode, 416);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video?part=1`)).statusCode, 200);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video?part=2`)).statusCode, 404);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video?part=../x`)).statusCode, 400);
  assert.equal((await call(null, 'GET', `/recordings/${recId}/video`)).statusCode, 401);

  // Wipe now: admins only.
  assert.equal((await call(viewer, 'DELETE', `/recordings/${recId}`)).statusCode, 403);
  assert.equal((await call(admin, 'DELETE', `/recordings/${recId}`)).statusCode, 200);
  assert.equal(existsSync(join(dir, 'ready', recId)), false);
  assert.equal((await call(viewer, 'GET', `/recordings/${recId}/video`)).statusCode, 404);
});

test('guests can never list or play recordings, including path tricks', async () => {
  const host = makeUser('g-host');
  const tankId = await openTank(host);
  const guest = makeUser('g-guest', 'member', tankId);
  const id = randomUUID();
  for (const url of ['/api/recordings', `/api/recordings/${id}/video`, '/api//recordings', '/api/recordings/', '/api/recordings%2F', '/api/./recordings']) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: guest.cookie } });
    assert.equal(res.statusCode, 403, url);
  }
  for (const url of ['/API/recordings', '/Api/Recordings']) {
    const res = await app.inject({ method: 'GET', url, headers: { cookie: guest.cookie } });
    assert.notEqual(res.statusCode, 200, url);
  }
  assert.deepEqual((await call(guest, 'GET', '/me')).json().features, { recordings: false });
  assert.deepEqual((await call(host, 'GET', '/me')).json().features, { recordings: true });
  await app.tanks.close(tankId, 'test');
});

test("a recording that the recorder never confirms fails cleanly (Neko's own status isn't trusted)", async () => {
  const admin = makeUser('fail-admin', 'admin');
  const tankId = await openTank(admin);
  orch.onBroadcastStart = null; // recorder down: Neko "broadcasts" into the void
  try {
    const res = await call(admin, 'POST', `/tanks/${tankId}/recording`);
    assert.equal(res.statusCode, 502);
    assert.match(res.json().error, /recorder did not receive/);
    assert.equal(orch.broadcasts.has(tankId), false, 'broadcast stopped again');
    const row = db.prepare('SELECT status FROM recordings WHERE tank_id = ? ORDER BY started_at DESC').get(tankId) as { status: string };
    assert.equal(row.status, 'failed');
  } finally {
    simulateRecorder();
  }
  // Neko still thinks it is broadcasting from before (422): reset and start.
  orch.broadcasts.set(tankId, 'rtmp://stale');
  assert.equal((await call(admin, 'POST', `/tanks/${tankId}/recording`)).statusCode, 201);
  // Tanks opened before recording was turned on can't record.
  await app.tanks.close(tankId, 'test');
  orch.recordable = false;
  const old = await openTank(admin);
  app.tanks.credentialsFor(old)!.recordable = false;
  assert.equal((await call(admin, 'GET', `/tanks/${old}`)).json().recording.supported, false);
  assert.equal((await call(admin, 'POST', `/tanks/${old}/recording`)).statusCode, 409);
  orch.recordable = true;
  await app.tanks.close(old, 'test');
});

test('watchdog: a dropped stream is restarted with a new key as the next part, then given up on', async () => {
  const admin = makeUser('wd-admin', 'admin');
  const tankId = await openTank(admin);
  const recId = (await call(admin, 'POST', `/tanks/${tankId}/recording`)).json().recording.id as string;
  const firstUrl = lastUrl(tankId);
  const busy = () => (app.recordings as unknown as { live: Map<string, { busy: boolean }> }).live.get(recId)?.busy;

  assert.equal((await event('notready', recId)).statusCode, 204); // recorder restarted
  await until(() => lastUrl(tankId) !== firstUrl);
  await until(() => busy() === false);
  const firstQuery = new URL(firstUrl.replace(/^rtmp:/, 'http:')).search.slice(1);
  assert.equal((await publish(recId, firstQuery)).statusCode, 403, 'the old key no longer works');
  assert.equal(app.recordings.get(recId)!.status, 'recording');

  // Stream stalls without any event (recorder killed): its file stops growing.
  mkdirSync(join(dir, 'raw', recId), { recursive: true });
  writeFileSync(join(dir, 'raw', recId, 'seg.mp4'), 'x');
  const secondUrl = lastUrl(tankId);
  await app.recordings.tick(Date.now() + 2 * HOUR);
  await until(() => busy() === false);
  assert.notEqual(lastUrl(tankId), secondUrl, 'restarted (part 3)');
  assert.equal(orch.broadcasts.get(tankId), lastUrl(tankId));

  // Recorder gone for good: restarts are never confirmed, and then the recording ends.
  orch.onBroadcastStart = null;
  try {
    await event('notready', recId); // restart 2 of 3: never confirmed
    await until(() => busy() === false, 2000);
    // The 2-hour jump above counted as a stable stream (which earns the restarts back), so that
    // stall was restart 1. Now restart 3, then give up.
    let attempts = 0;
    while (app.recordings.get(recId)!.status === 'recording' && attempts < 6) {
      await app.recordings.tick();
      await until(() => busy() !== true, 2000);
      attempts++;
    }
    assert.equal(app.recordings.get(recId)!.status, 'processing', 'gave up');
    assert.equal(attempts, 2, 'after the third restart failed');
    assert.equal(orch.broadcasts.has(tankId), false);
  } finally {
    simulateRecorder();
    rmSync(join(dir, 'raw', recId), { recursive: true, force: true });
  }
  await app.tanks.close(tankId, 'test');
});

test('max length, startup reconcile, retention sweep and orphan cleanup', async () => {
  const admin = makeUser('sw-admin', 'admin');
  const tankId = await openTank(admin);
  const recId = (await call(admin, 'POST', `/tanks/${tankId}/recording`)).json().recording.id as string;
  writePart(recId, 'only', 5000); // what the recorder will have written
  await app.recordings.tick(Date.now() + 9 * HOUR);
  assert.equal(app.recordings.get(recId)!.status, 'ready', 'RECORDING_MAX_HOURS cutoff, then processed');
  assert.equal(orch.broadcasts.has(tankId), false);

  // A recording whose Tank vanished while the app was down.
  const ghost = randomUUID();
  db.prepare(
    "INSERT INTO recordings (id, tank_id, tank_name, started_by_name, key_hash, status, started_at) VALUES (?, NULL, 'Gone', 'x', 'h', 'recording', ?)",
  ).run(ghost, Date.now() - HOUR);
  await app.recordings.reconcile();
  assert.equal(app.recordings.get(ghost)!.status, 'processing');
  // Nothing ever arrived for it: failed after the grace period, wiped by the next sweep.
  await app.recordings.tick(Date.now() + 3 * 60_000);
  assert.equal(app.recordings.get(ghost)!.status, 'failed');

  const orphan = randomUUID();
  mkdirSync(join(dir, 'ready', orphan));
  mkdirSync(join(dir, 'raw', 'not-a-recording'));
  const expires = app.recordings.get(recId)!.expires_at!;
  await app.recordings.sweep(expires - 1000);
  assert.ok(app.recordings.get(recId), 'kept until it expires');
  assert.equal(app.recordings.get(ghost), null, 'failed ones go at once');
  assert.equal(existsSync(join(dir, 'ready', orphan)), false, 'orphan folder removed');
  assert.equal(existsSync(join(dir, 'raw', 'not-a-recording')), true, 'only recording-shaped names are touched');
  await app.recordings.sweep(expires);
  assert.equal(app.recordings.get(recId), null);
  assert.equal(existsSync(join(dir, 'ready', recId)), false);
  rmSync(join(dir, 'raw', 'not-a-recording'), { recursive: true });
  await app.tanks.close(tankId, 'test');
});

test('recording timer: set at start, changed or cleared while live, stops on time', async () => {
  const admin = makeUser('t-admin', 'admin');
  const member = makeUser('t-member');
  const tankId = await openTank(admin, member);
  const now = Date.now();
  const rec = (body: object) => call(admin, 'POST', `/tanks/${tankId}/recording`, {}, body);

  assert.equal((await rec({ stopAt: now + 10_000 })).statusCode, 400, 'at least a minute ahead');
  assert.equal((await rec({ stopAt: now + 9 * HOUR })).statusCode, 400, 'within RECORDING_MAX_HOURS');
  assert.equal((await rec({ stopAt: 'soon' })).statusCode, 400);
  assert.equal((await rec({ minutes: 5 })).statusCode, 400, 'unknown fields refused');

  const started = await rec({ stopAt: now + 30 * 60_000 });
  assert.equal(started.statusCode, 201, started.body);
  const recId = started.json().recording.id as string;
  assert.equal(started.json().recording.stopAt, now + 30 * 60_000);
  assert.equal((await call(member, 'GET', `/tanks/${tankId}`)).json().recording.active.stopAt, now + 30 * 60_000, 'everyone sees when it stops');

  // Change and clear.
  assert.equal((await call(member, 'PATCH', `/tanks/${tankId}/recording`, {}, { stopAt: now + HOUR })).statusCode, 403);
  assert.equal((await call(admin, 'PATCH', `/tanks/${tankId}/recording`, {}, { stopAt: now + HOUR })).statusCode, 200);
  assert.equal(app.recordings.get(recId)!.stop_at, now + HOUR);
  assert.equal((await call(admin, 'PATCH', `/tanks/${tankId}/recording`, {}, { stopAt: null })).statusCode, 200);
  assert.equal(app.recordings.get(recId)!.stop_at, null);
  await app.recordings.tick(now + 2 * HOUR);
  assert.equal(app.recordings.get(recId)!.status, 'recording', 'no timer: keeps going');

  assert.equal((await call(admin, 'PATCH', `/tanks/${tankId}/recording`, {}, { stopAt: Date.now() + 2 * 60_000 })).statusCode, 200);
  await app.recordings.tick(Date.now() + 60_000);
  assert.equal(app.recordings.get(recId)!.status, 'recording', 'not yet');
  await app.recordings.tick(Date.now() + 2 * 60_000 + 1);
  assert.notEqual(app.recordings.get(recId)!.status, 'recording', 'stopped by the timer');
  assert.equal(orch.broadcasts.has(tankId), false);
  assert.equal((await call(admin, 'PATCH', `/tanks/${tankId}/recording`, {}, { stopAt: null })).statusCode, 404, 'nothing to change');
  await app.tanks.close(tankId, 'test');
});

/** A finished recording, as if recorded earlier (not tied to any Tank). */
function readyRecording(name: string): string {
  const id = randomUUID();
  const now = Date.now();
  writePart(id, 'p0', 5000);
  db.prepare(
    `INSERT INTO recordings (id, tank_id, tank_name, started_by, started_by_name, key_hash, status, started_at, ended_at, expires_at, duration_ms, size_bytes, parts)
     VALUES (?, NULL, ?, NULL, 'someone', 'x', 'ready', ?, ?, ?, 5000, 4100, ?)`,
  ).run(id, name, now - HOUR, now - HOUR + 5000, now + 24 * HOUR, JSON.stringify([{ file: 'p0.mp4', durationMs: 5000, sizeBytes: 4100 }]));
  return id;
}

test('watch together: every open Tank can play any finished recording from its own address; accounts can send one to open there', async () => {
  const host = makeUser('wt-host');
  const friend = makeUser('wt-friend');
  const outsider = makeUser('wt-outsider');
  const admin = makeUser('wt-admin', 'admin');
  const tankId = await openTank(host, friend);
  const otherTank = await openTank(makeUser('wt-other'));
  const guest = makeUser('wt-guest', 'member', tankId);
  db.prepare("INSERT INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'guest', ?)").run(tankId, guest.id, Date.now());
  const IP = '10.88.2.140';
  orch.addresses.set(tankId, IP);
  orch.addresses.set(otherTank, '10.88.2.141');
  const recId = readyRecording('Movie night');
  const pending = readyRecording('Not shared');

  const playback = await buildTankPlayback(app.recordings);
  const tp = (ip: string, url: string, headers: Record<string, string> = {}) => playback.inject({ method: 'GET', url, remoteAddress: ip, headers });
  const shared = async (ip: string) => (await tp(ip, '/shared.json')).json().shared as Array<{ id: string; sharedBy: string }>;
  const listed = async (ip: string) => ((await tp(ip, '/shared.json')).json().recordings as Array<{ id: string }>).map((r) => r.id);
  try {
    assert.deepEqual(await shared(IP), []);
    // Every finished recording is on every open Tank's page, shared or not.
    assert.ok((await listed(IP)).includes(recId) && (await listed(IP)).includes(pending));
    assert.equal((await tp(IP, `/r/${pending}/video`)).statusCode, 200);
    // Only an open Tank's own address gets anything: not the app, Caddy, other containers or the LAN.
    for (const ip of ['127.0.0.1', '10.88.2.2', '10.88.2.199', '192.168.0.5', '::1']) {
      for (const url of ['/', '/shared.json', `/r/${recId}`, `/r/${recId}/video`, '/tank.js']) assert.equal((await tp(ip, url)).statusCode, 404, `${ip} ${url}`);
    }

    // Who may share: accounts in the Tank. Not guests (API allowlist), not outsiders.
    assert.equal((await call(guest, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: recId })).statusCode, 403);
    assert.equal((await call(outsider, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: recId })).statusCode, 404);
    assert.equal((await call(friend, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: randomUUID() })).statusCode, 404);
    assert.equal((await call(friend, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: recId })).statusCode, 200);

    // The Tank page shows it, and the Tank-side page lists and plays it.
    const detail = (await call(friend, 'GET', `/tanks/${tankId}`)).json();
    assert.equal(detail.recording.canShare, true);
    assert.equal(detail.recording.tankUrl, 'http://10.88.2.2:3001/');
    assert.deepEqual(detail.recording.shared.map((s: { id: string }) => s.id), [recId]);
    assert.equal((await call(guest, 'GET', `/tanks/${tankId}`)).json().recording.canShare, false);
    assert.deepEqual((await shared(IP)).map((s) => [s.id, s.sharedBy]), [[recId, 'wt-friend']]);
    const page = await tp(IP, `/r/${recId}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-security-policy'] as string, /script-src 'self'/);
    const video = await tp(IP, `/r/${recId}/video`, { range: 'bytes=0-7' });
    assert.equal(video.statusCode, 206);
    assert.equal(video.headers['content-range'], `bytes 0-7/${fakeMp4(5000).length}`);
    // Sending is per Tank (it opens only there), but another Tank can still play it from its list.
    assert.deepEqual(await shared('10.88.2.141'), []);
    assert.equal((await tp('10.88.2.141', `/r/${recId}/video`)).statusCode, 200);
    assert.equal((await tp(IP, `/r/${randomUUID()}/video`)).statusCode, 404);
    // No API on this port.
    for (const url of ['/api/recordings', '/api/health', `/api/recordings/${recId}/video`]) assert.equal((await tp(IP, url)).statusCode, 404);

    // Sharing again puts it back on top; anyone in the Tank can take one off.
    assert.equal((await call(host, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: pending })).statusCode, 200);
    assert.deepEqual((await shared(IP)).map((s) => s.id), [pending, recId]);
    assert.equal((await call(host, 'DELETE', `/tanks/${tankId}/playback/${recId}`)).statusCode, 200);
    assert.equal((await call(host, 'DELETE', `/tanks/${tankId}/playback/${recId}`)).statusCode, 404);
    assert.deepEqual((await shared(IP)).map((s) => s.id), [pending]);

    // A wiped recording disappears from the Tank too.
    assert.equal((await call(admin, 'DELETE', `/recordings/${pending}`)).statusCode, 200);
    assert.deepEqual(await shared(IP), []);
    assert.equal((await listed(IP)).includes(pending), false);
    assert.equal((await tp(IP, `/r/${pending}/video`)).statusCode, 404);

    // Closing the Tank forgets its shares and its address.
    assert.equal((await call(friend, 'POST', `/tanks/${tankId}/playback`, {}, { recordingId: recId })).statusCode, 200);
    await app.tanks.close(tankId, 'test');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tank_recordings WHERE tank_id = ?').get(tankId) as { n: number }).n, 0);
    assert.equal((await tp(IP, '/shared.json')).statusCode, 404);
  } finally {
    await playback.close();
  }
});

test('Tank browser: a Recordings tile and bookmark, and autoplay allowed for it, only with recording on', () => {
  assert.equal(loadConfig({}).tanks.recordingsUrl, null);
  assert.equal(loadConfig({ RECORDING_ENABLED: 'true' }).tanks.recordingsUrl, 'http://10.88.2.2:3001/');
  assert.equal(loadConfig({ RECORDING_ENABLED: 'true' }).recording.tankPort, 3001);
  const p = withFishTankPolicies({ policies: {} }, [{ title: 'Recordings', url: 'http://10.88.2.2:3001/' }], [], ['http://10.88.2.2:3001']) as {
    policies: { Permissions: { Autoplay: { Allow: string[] } }; Bookmarks: Array<{ Title: string }> };
  };
  assert.deepEqual(p.policies.Permissions.Autoplay.Allow, ['http://10.88.2.2:3001']);
  assert.ok(p.policies.Bookmarks.some((b) => b.Title === 'Recordings'));
  assert.equal('Permissions' in (withFishTankPolicies({ policies: {} }, []) as { policies: object }).policies, false);
});

test('clips: any account in a recorded Tank saves the last minute; guests and outsiders cannot', async () => {
  const admin = makeUser('clip-admin', 'admin');
  const member = makeUser('clip-member');
  const outsider = makeUser('clip-outsider');
  const tankId = await openTank(admin, member);
  const guest = makeUser('clip-guest', 'member', tankId);
  db.prepare("INSERT INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'guest', ?)").run(tankId, guest.id, Date.now());
  const clip = (u: U) => call(u, 'POST', `/tanks/${tankId}/clip`);

  assert.equal((await clip(member)).statusCode, 409, 'only while recording');
  assert.equal((await call(admin, 'POST', `/tanks/${tankId}/recording`)).statusCode, 201);
  const recId = app.recordings.activeFor(tankId)!.id;
  assert.equal((await clip(guest)).statusCode, 403, 'guests can not');
  assert.equal((await clip(outsider)).statusCode, 404, 'must be in the Tank');

  // A member (not an admin) clips: the last 60 s of the 90 s the recorder has.
  recorderCalls.length = 0;
  const res = await clip(member);
  assert.equal(res.statusCode, 201, res.body);
  const { id, durationMs } = res.json().clip;
  assert.equal(durationMs, 60_000);
  const get = recorderCalls.find((u) => u.pathname === '/get')!;
  assert.equal(get.searchParams.get('path'), recId);
  assert.equal(get.searchParams.get('duration'), '60.000');
  assert.equal(get.searchParams.get('format'), 'mp4');
  const listed = (await call(member, 'GET', '/recordings')).json().recordings.find((r: { id: string }) => r.id === id);
  assert.equal(listed.kind, 'clip');
  assert.equal(listed.status, 'ready');
  assert.equal(listed.startedBy, 'clip-member');
  assert.ok(listed.expiresAt > Date.now());
  assert.equal((await call(outsider, 'GET', `/recordings/${id}/video`, { range: 'bytes=0-7' })).statusCode, 206, 'every account can watch it');

  // The playback hook only lets the app in, and only for a live recording.
  const hook = (password: string, path = recId) =>
    app.inject({ method: 'POST', url: '/auth/recorder', payload: { action: 'playback', path, ip: '10.88.2.250', user: 'fishtank-app', password } });
  assert.equal((await hook('guess')).statusCode, 403);
  assert.equal((await hook('')).statusCode, 403);

  // Too little recorded yet, or the recorder fails: a clear error, nothing left behind.
  const before = new Set(readdirSync(join(dir, 'ready')));
  const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE kind = 'clip'").get() as { n: number }).n;
  const n = rows();
  recorderSpans = [{ start: new Date(Date.now() - 1000).toISOString(), duration: 1 }];
  assert.equal((await clip(member)).statusCode, 409);
  recorderSpans = null;
  recorderFails = true;
  assert.equal((await clip(member)).statusCode, 502);
  recorderFails = false;
  assert.equal(rows(), n);
  assert.deepEqual(new Set(readdirSync(join(dir, 'ready'))), before);

  // After the recording stops: no more clips, and the playback hook refuses it too. The clip stays.
  assert.equal((await call(admin, 'DELETE', `/tanks/${tankId}/recording`)).statusCode, 200);
  assert.equal((await clip(member)).statusCode, 409);
  assert.ok(app.recordings.get(id));
});

test('mp4 duration comes from the movie header', async () => {
  const p = join(dir, 'd.mp4');
  writeFileSync(p, fakeMp4(3_723_000));
  assert.equal(await mp4DurationMs(p), 3_723_000);
  writeFileSync(p, 'not an mp4 at all');
  assert.equal(await mp4DurationMs(p), null);
  rmSync(p);
});

test('with recording off: no routes, no hooks, nothing in Tank details', async () => {
  const offDb = openDb(':memory:');
  const offOrch = new FakeOrchestrator();
  const base = loadConfig({});
  const off = await buildApp({ config: { ...base, appOrigins: [ORIGIN], publicUrl: ORIGIN }, db: offDb, orchestrator: offOrch }, { logger: false });
  try {
    const id = randomUUID();
    offDb.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at) VALUES (?, 'oa', 'oa', 'x', 'admin', ?)").run(id, Date.now());
    const cookie = `${SESSION_COOKIE}=${createSession(offDb, id, 30)}`;
    const tank = off.tanks.create(id, 'Off');
    await until(() => off.tanks.get(tank.id)?.status === 'open');
    assert.equal(off.tanks.credentialsFor(tank.id)!.recordable, false);
    const h = { origin: ORIGIN, cookie };
    assert.equal((await off.inject({ method: 'GET', url: '/api/recordings', headers: h })).statusCode, 404);
    assert.equal((await off.inject({ method: 'POST', url: `/api/tanks/${tank.id}/recording`, headers: h })).statusCode, 404);
    assert.equal((await off.inject({ method: 'POST', url: '/auth/recorder', payload: {} })).statusCode, 404);
    assert.equal((await off.inject({ method: 'GET', url: `/api/tanks/${tank.id}`, headers: h })).json().recording, null);
    assert.deepEqual((await off.inject({ method: 'GET', url: '/api/me', headers: h })).json().features, { recordings: false });
    await off.tanks.close(tank.id, 'test');
  } finally {
    await off.close();
    offDb.close();
  }
});
