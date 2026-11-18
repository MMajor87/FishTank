import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { BroadcastError, type Orchestrator } from './orchestrator.ts';
import type { Hub, RealtimeEvent } from './realtime.ts';
import { newToken, sha256 } from './security.ts';
import type { SessionUser } from './sessions.ts';
import { TankError, type TankService } from './tanks.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Finished MP4s in ready/<id>/ (the remux writes to a hidden .part file first). */
const PART_FILE = /^[A-Za-z0-9][A-Za-z0-9_+-]*\.mp4$/;
/** Neko never reconnects by itself; the app restarts a dropped stream this many times. */
const MAX_RESTARTS = 3;
const STABLE_MS = 10 * MINUTE;

export interface RecordingPart {
  file: string;
  durationMs: number;
  sizeBytes: number;
}

export interface RecordingRow {
  id: string;
  tank_id: string | null;
  tank_name: string;
  started_by: string | null;
  started_by_name: string;
  key_hash: string;
  status: 'recording' | 'processing' | 'ready' | 'failed';
  started_at: number;
  ended_at: number | null;
  expires_at: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  parts: string | null;
  error: string | null;
  stop_at: number | null;
  kind: 'recording' | 'clip';
  source_id: string | null;
}

/** What MediaMTX sends to its HTTP auth hook (see docs/RECORDING.md, spike results). */
export interface RecorderAuthRequest {
  action?: string;
  path?: string;
  query?: string;
  ip?: string;
  protocol?: string;
  user?: string;
  password?: string;
}

/** In-memory state of a recording that is live right now. */
interface Live {
  tankId: string;
  /** The recorder said the stream is up (its "ready" event), and hasn't said it dropped since. */
  up: boolean;
  /** When the stream last (re)started, for the stall check's grace period. */
  since: number;
  restarts: number;
  /** A start/restart is waiting for the recorder's "ready" event. */
  waiter: { resolve: () => void; reject: (err: Error) => void } | null;
  /** A restart or stop is in progress. */
  busy: boolean;
}

export interface RecordingTimings {
  /** How long the recorder has to confirm a (re)started stream. */
  readyTimeoutMs: number;
  /** A live stream whose file hasn't grown for this long is treated as dropped. */
  stallMs: number;
  /** A finished recording whose files never appear is marked failed after this long. */
  processTimeoutMs: number;
  /** Watchdog / processing check interval. */
  tickMs: number;
}

const DEFAULT_TIMINGS: RecordingTimings = { readyTimeoutMs: 15 * SECOND, stallMs: 45 * SECOND, processTimeoutMs: 30 * MINUTE, tickMs: 5 * SECOND };

export interface RecordingDeps {
  config: Config;
  db: DB;
  hub: Hub;
  orchestrator: Orchestrator;
  tanks: TankService;
  log: FastifyBaseLogger;
  timings?: Partial<RecordingTimings>;
  /** HTTP client for the recorder's playback server (tests pass a fake). */
  fetch?: typeof fetch;
}

/**
 * Tank recordings (docs/RECORDING.md). An admin starts one; the app tells the Tank's Neko to push
 * its screen to the recorder (MediaMTX) with a one-off key, which the recorder checks with
 * authorizePublish(). The recorder's own events, not Neko's status, say whether the stream is up.
 * A finished recording is served to every account until RECORDING_KEEP_DAYS after it ended.
 */
export class RecordingManager {
  readonly enabled: boolean;
  private cfg: Config['recording'];
  private db: DB;
  private hub: Hub;
  private orch: Orchestrator;
  private tanks: TankService;
  private log: FastifyBaseLogger;
  private t: RecordingTimings;
  private live = new Map<string, Live>();
  /** Tank id → its container's IP, for the Tank-side playback server. Dropped when the Tank closes. */
  private addresses = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private fetch: typeof fetch;
  /** The app's password for the recorder's playback server (checked by our own auth hook). */
  private playbackSecret = newToken();
  /** Tanks with a clip being saved, and those clips' ids (the sweep leaves their folders alone). */
  private clipping = new Set<string>();
  private clipIds = new Set<string>();
  private lastShareAt = 0;

  constructor(deps: RecordingDeps) {
    this.cfg = deps.config.recording;
    this.enabled = this.cfg.enabled;
    this.db = deps.db;
    this.hub = deps.hub;
    this.orch = deps.orchestrator;
    this.tanks = deps.tanks;
    this.log = deps.log;
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.fetch = deps.fetch ?? fetch;
  }

  /* ---------------- queries ---------------- */

  get(id: string): RecordingRow | null {
    return (this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined) ?? null;
  }

  activeFor(tankId: string): RecordingRow | null {
    return (
      (this.db.prepare("SELECT * FROM recordings WHERE tank_id = ? AND status = 'recording'").get(tankId) as RecordingRow | undefined) ?? null
    );
  }

  /** The Tank page's recording panel: whether this person may record, and what is running. */
  tankInfo(tankId: string, user: SessionUser) {
    if (!this.enabled) return null;
    const active = this.activeFor(tankId);
    return {
      canRecord: user.role === 'admin' && !user.guestTankId,
      // Tanks opened before recording was turned on have no broadcast pipeline.
      supported: !!this.tanks.credentialsFor(tankId)?.recordable,
      active: active ? { id: active.id, startedBy: active.started_by_name, startedAt: active.started_at, stopAt: active.stop_at } : null,
      /** Latest allowed timer for a new recording (RECORDING_MAX_HOURS from now). */
      maxHours: this.cfg.maxHours,
      keepDays: this.cfg.keepDays,
      /** Accounts in the Tank may share a recording to play here (guests only watch it). */
      canShare: !user.guestTankId,
      /** Accounts in the Tank (not guests) may clip the last minute while it's recorded. */
      canClip: !user.guestTankId,
      clipSeconds: this.cfg.clipSeconds,
      /** The Tank-side Recordings page, as the Tank's browser reaches it. */
      tankUrl: `${this.cfg.tankUrl}/`,
      shared: this.sharedFor(tankId),
    };
  }

  /** Recordings people can see: live, processing and ready ones, newest first. */
  list(now = Date.now()) {
    const rows = this.db
      .prepare("SELECT * FROM recordings WHERE status IN ('recording', 'processing', 'ready') ORDER BY started_at DESC")
      .all() as unknown as RecordingRow[];
    return rows.map((r) => ({
      id: r.id,
      tankName: r.tank_name,
      startedBy: r.started_by_name,
      kind: r.kind,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      expiresAt: r.expires_at,
      durationMs: r.status === 'recording' ? now - r.started_at : r.duration_ms,
      sizeBytes: r.size_bytes,
      parts: parseParts(r.parts).map((p, index) => ({ index, durationMs: p.durationMs, sizeBytes: p.sizeBytes })),
    }));
  }

  /** Disk use for the admin page. */
  async storage() {
    const used = this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM recordings WHERE status = 'ready'").get() as { n: number };
    return { usedBytes: used.n, freeBytes: await this.freeBytes(), keepDays: this.cfg.keepDays, minFreeGb: this.cfg.minFreeGb };
  }

  /** Absolute path of one finished part, or null. */
  partPath(id: string, index: number): string | null {
    const r = UUID.test(id) ? this.get(id) : null;
    if (!r || r.status !== 'ready') return null;
    const part = parseParts(r.parts)[index];
    if (!part || !PART_FILE.test(part.file)) return null;
    return join(this.cfg.dir, 'ready', id, part.file);
  }

  /* ---------------- start / stop ---------------- */

  /**
   * Checks a requested stop time for a recording that started (or starts) at `startedAt`.
   * null = no timer (RECORDING_MAX_HOURS and the Tank's own lifetime still apply).
   */
  private checkStopAt(stopAt: number | null, startedAt: number, now = Date.now()): number | null {
    if (stopAt === null) return null;
    if (!Number.isFinite(stopAt) || stopAt < now + MINUTE) throw new TankError('Pick a stop time at least a minute from now', 400);
    if (stopAt > startedAt + this.cfg.maxHours * HOUR) {
      throw new TankError(`A recording can last at most ${this.cfg.maxHours} hours`, 400);
    }
    return Math.round(stopAt);
  }

  /** Sets, changes or clears (null) the timer of a Tank's live recording. Any admin. */
  setTimer(tankId: string, stopAt: number | null): RecordingRow {
    if (!this.enabled) throw new TankError('Not found', 404);
    const r = this.activeFor(tankId);
    if (!r) throw new TankError("This Tank isn't being recorded", 404);
    const at = this.checkStopAt(stopAt, r.started_at);
    this.db.prepare("UPDATE recordings SET stop_at = ? WHERE id = ? AND status = 'recording'").run(at, r.id);
    this.log.info({ recordingId: r.id, stopAt: at }, 'recording timer set');
    this.notifyTank(tankId, { type: 'tank.recording', tankId, name: r.tank_name, active: true, by: null });
    return this.get(r.id)!;
  }

  async start(tankId: string, user: SessionUser, opts: { stopAt?: number | null } = {}): Promise<RecordingRow> {
    if (!this.enabled) throw new TankError('Not found', 404);
    const tank = this.tanks.get(tankId);
    if (!tank || tank.status === 'closed' || !this.tanks.role(tankId, user.id)) throw new TankError('Tank not found', 404);
    if (user.role !== 'admin' || user.guestTankId) throw new TankError('Only admins can record', 403);
    if (tank.status !== 'open') throw new TankError("The Tank isn't open yet", 409);
    const creds = this.tanks.credentialsFor(tankId);
    if (!creds?.apiToken || !creds.recordable) {
      throw new TankError('This Tank was opened before recording was turned on. Drain it and open a new one to record.', 409);
    }
    if (this.activeFor(tankId)) throw new TankError('This Tank is already being recorded', 409);
    const free = await this.freeBytes();
    if (free === null) throw new TankError("Recording storage isn't set up", 503);
    if (free < this.cfg.minFreeGb * 1024 ** 3) throw new TankError('Not enough free disk space to record', 507);

    const id = randomUUID();
    const key = newToken();
    const now = Date.now();
    const stopAt = this.checkStopAt(opts.stopAt ?? null, now, now);
    try {
      this.db
        .prepare(
          `INSERT INTO recordings (id, tank_id, tank_name, started_by, started_by_name, key_hash, status, started_at, stop_at)
           VALUES (?, ?, ?, ?, ?, ?, 'recording', ?, ?)`,
        )
        .run(id, tankId, tank.name, user.id, user.displayName, sha256(key), now, stopAt);
    } catch {
      throw new TankError('This Tank is already being recorded', 409); // the one-per-Tank index
    }
    const state: Live = { tankId, up: false, since: now, restarts: 0, waiter: null, busy: true };
    this.live.set(id, state);
    try {
      await this.connect(id, state, key);
    } catch (err) {
      this.live.delete(id);
      const msg = (err as Error).message;
      const res = this.db
        .prepare("UPDATE recordings SET status = 'failed', ended_at = ?, expires_at = ?, error = ? WHERE id = ? AND status = 'recording'")
        .run(Date.now(), Date.now(), msg, id);
      if (res.changes) {
        await this.orch.stopBroadcast(tankId, creds.apiToken).catch(() => {});
        this.log.warn({ err, tankId, recordingId: id }, 'recording failed to start');
      }
      throw new TankError(`The recording couldn't start: ${msg}`, 502);
    } finally {
      state.busy = false;
    }
    this.log.info({ tankId, recordingId: id, by: user.username }, 'recording started');
    this.notifyTank(tankId, { type: 'tank.recording', tankId, name: tank.name, active: true, by: user.displayName });
    this.notifyAccounts();
    return this.get(id)!;
  }

  /**
   * Ends a live recording: stops Neko's broadcast, starts the retention clock, and leaves the
   * recorder to finish the files (processing → ready in tick()). Returns false if it wasn't live.
   */
  async stop(id: string, reason: string): Promise<boolean> {
    const row = this.get(id);
    if (!row || row.status !== 'recording') return false;
    const state = this.live.get(id);
    if (state) {
      state.busy = true;
      state.waiter?.reject(new Error('stopped'));
    }
    const token = row.tank_id ? this.tanks.credentialsFor(row.tank_id)?.apiToken : undefined;
    if (row.tank_id && token) {
      await this.orch.stopBroadcast(row.tank_id, token).catch((err) => this.log.warn({ err, recordingId: id }, 'could not stop neko broadcast'));
    }
    const now = Date.now();
    const res = this.db
      .prepare("UPDATE recordings SET status = 'processing', ended_at = ?, expires_at = ? WHERE id = ? AND status = 'recording'")
      .run(now, now + this.cfg.keepDays * DAY, id);
    this.live.delete(id);
    if (!res.changes) return false;
    this.log.info({ tankId: row.tank_id, recordingId: id, reason }, 'recording stopped');
    if (row.tank_id) this.notifyTank(row.tank_id, { type: 'tank.recording', tankId: row.tank_id, name: row.tank_name, active: false, by: null });
    this.notifyAccounts();
    return true;
  }

  /** Stops the Tank's recording, if any, and forgets what was shared to it. Called before a Tank's container is removed. */
  async endForTank(tankId: string, reason: string): Promise<void> {
    this.db.prepare('DELETE FROM tank_recordings WHERE tank_id = ?').run(tankId);
    this.addresses.delete(tankId);
    const r = this.activeFor(tankId);
    if (r) await this.stop(r.id, reason);
  }

  /* ---------------- clips ---------------- */

  /**
   * Saves the last RECORDING_CLIP_SECONDS of a Tank's live recording as its own short recording.
   * Any account in the Tank (not guests). The recorder's playback server cuts it (no re-encode).
   */
  async clip(tankId: string, user: SessionUser): Promise<RecordingRow> {
    if (!this.enabled) throw new TankError('Not found', 404);
    if (user.guestTankId || !this.tanks.canAccess(tankId, user.id)) throw new TankError('Tank not found', 404);
    const tank = this.tanks.get(tankId)!;
    const src = this.activeFor(tankId);
    if (!src) throw new TankError('Clips can only be made while the Tank is being recorded', 409);
    if (this.clipping.has(tankId)) throw new TankError('A clip is already being saved. Try again in a moment.', 409);
    const free = await this.freeBytes();
    if (free !== null && free < this.cfg.minFreeGb * 1024 ** 3) throw new TankError('Not enough free disk space for a clip', 507);

    const id = randomUUID();
    const dir = join(this.cfg.dir, 'ready', id);
    this.clipping.add(tankId);
    this.clipIds.add(id);
    try {
      const headers = { authorization: `Basic ${Buffer.from(`${PLAYBACK_USER}:${this.playbackSecret}`).toString('base64')}` };
      // What the recorder has for this recording: spans of continuous recording (one per part).
      const list = await this.fetch(`${this.cfg.playbackUrl}/list?${new URLSearchParams({ path: src.id })}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!list.ok) throw new Error(`recorder list failed: ${list.status}`);
      const spans = (await list.json()) as Array<{ start: string; duration: number }>;
      const last = Array.isArray(spans) ? spans.at(-1) : undefined;
      const lastStart = last ? Date.parse(last.start) : NaN;
      const end = lastStart + (Number(last?.duration) || 0) * SECOND;
      const from = Math.max(lastStart, end - this.cfg.clipSeconds * SECOND);
      if (!Number.isFinite(from) || end - from < 2 * SECOND) {
        throw new TankError('Nothing has been recorded yet. Try again in a few seconds.', 409);
      }
      const seconds = (end - from) / SECOND;
      const get = await this.fetch(
        `${this.cfg.playbackUrl}/get?${new URLSearchParams({ path: src.id, start: new Date(from).toISOString(), duration: seconds.toFixed(3), format: 'mp4' })}`,
        { headers, signal: AbortSignal.timeout(2 * MINUTE) },
      );
      if (!get.ok || !get.body) throw new Error(`recorder get failed: ${get.status}`);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, '.clip.mp4.part');
      const out = join(dir, 'clip.mp4');
      await pipeline(Readable.fromWeb(get.body as WebReadableStream<Uint8Array>), createWriteStream(tmp));
      await rename(tmp, out);
      const sizeBytes = (await stat(out)).size;
      const durationMs = (await mp4DurationMs(out).catch(() => null)) || Math.round(seconds * SECOND);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO recordings (id, tank_id, tank_name, started_by, started_by_name, key_hash, status, started_at, ended_at, expires_at,
                                   duration_ms, size_bytes, parts, kind, source_id)
           VALUES (?, ?, ?, ?, ?, '-', 'ready', ?, ?, ?, ?, ?, ?, 'clip', ?)`,
        )
        .run(id, tankId, tank.name, user.id, user.displayName, Math.round(from), Math.round(end), now + this.cfg.keepDays * DAY, durationMs, sizeBytes,
          JSON.stringify([{ file: 'clip.mp4', durationMs, sizeBytes }]), src.id);
      this.log.info({ tankId, clipId: id, recordingId: src.id, by: user.username, durationMs, sizeBytes }, 'clip saved');
      this.notifyTank(tankId, { type: 'tank.clip', tankId, by: user.displayName, seconds: Math.round(durationMs / SECOND) });
      this.notifyAccounts();
      return this.get(id)!;
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof TankError) throw err;
      this.log.warn({ err, tankId, recordingId: src.id }, 'clip failed');
      throw new TankError("The clip couldn't be saved. Try again.", 502);
    } finally {
      this.clipping.delete(tankId);
      this.clipIds.delete(id);
    }
  }

  /* ---------------- watching together in a Tank (Phase 5) ---------------- */

  /** Ready recordings shared to a Tank, most recently shared first. */
  sharedFor(tankId: string) {
    const rows = this.db
      .prepare(
        `SELECT r.*, s.shared_by_name AS shared_by_name_, s.shared_at AS shared_at_
         FROM tank_recordings s JOIN recordings r ON r.id = s.recording_id
         WHERE s.tank_id = ? AND r.status = 'ready' ORDER BY s.shared_at DESC`,
      )
      .all(tankId) as unknown as Array<RecordingRow & { shared_by_name_: string; shared_at_: number }>;
    return rows.map((r) => ({
      id: r.id,
      tankName: r.tank_name,
      startedBy: r.started_by_name,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      expiresAt: r.expires_at,
      parts: parseParts(r.parts).map((p, index) => ({ index, durationMs: p.durationMs })),
      sharedBy: r.shared_by_name_,
      sharedAt: r.shared_at_,
    }));
  }

  /** An account in an open Tank shares a ready recording to play there. Sharing again brings it back to the top. */
  share(tankId: string, recordingId: string, user: SessionUser): void {
    if (!this.enabled) throw new TankError('Not found', 404);
    if (user.guestTankId || !this.tanks.canAccess(tankId, user.id)) throw new TankError('Tank not found', 404);
    const r = UUID.test(recordingId) ? this.get(recordingId) : null;
    if (!r || r.status !== 'ready') throw new TankError('Recording not found', 404);
    const now = Math.max(Date.now(), this.lastShareAt + 1); // strictly increasing: the Tank page opens the newest
    this.lastShareAt = now;
    this.db
      .prepare(
        `INSERT INTO tank_recordings (tank_id, recording_id, shared_by, shared_by_name, shared_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tank_id, recording_id) DO UPDATE SET shared_by = excluded.shared_by, shared_by_name = excluded.shared_by_name, shared_at = excluded.shared_at`,
      )
      .run(tankId, r.id, user.id, user.displayName, now);
    this.log.info({ tankId, recordingId: r.id, by: user.username }, 'recording shared to a tank');
    this.notifyTank(tankId, { type: 'tank.playback', tankId, title: r.tank_name, startedAt: r.started_at, by: user.displayName });
  }

  /** Takes a recording off a Tank's list. Any account in the Tank. */
  unshare(tankId: string, recordingId: string, user: SessionUser): void {
    if (!this.enabled) throw new TankError('Not found', 404);
    if (user.guestTankId || !this.tanks.canAccess(tankId, user.id)) throw new TankError('Tank not found', 404);
    const res = this.db.prepare('DELETE FROM tank_recordings WHERE tank_id = ? AND recording_id = ?').run(tankId, recordingId);
    if (!res.changes) throw new TankError("That recording isn't shared to this Tank", 404);
    for (const uid of this.tanks.memberIds(tankId)) this.hub.send(uid, { type: 'tank.updated', tankId });
  }

  /** Which open Tank a request to the Tank-side playback server comes from, by its source IP (null = none). */
  async tankForAddress(ip: string): Promise<string | null> {
    if (!this.enabled) return null;
    const addr = ip.replace(/^::ffff:/i, '');
    if (!inCidr(addr, this.cfg.publisherCidr)) return null;
    const open = this.db.prepare("SELECT id FROM tanks WHERE status = 'open'").all() as Array<{ id: string }>;
    for (const { id } of open) {
      let a = this.addresses.get(id);
      if (!a) {
        a = (await this.orch.address(id).catch(() => null)) ?? undefined;
        if (a) this.addresses.set(id, a);
      }
      if (a === addr) return id;
    }
    return null;
  }

  /** Every finished recording, newest first, for a Tank's Recordings page. */
  readyList() {
    return this.list()
      .filter((r) => r.status === 'ready')
      .map((r) => ({ id: r.id, tankName: r.tankName, kind: r.kind, startedBy: r.startedBy, startedAt: r.startedAt, durationMs: r.durationMs, parts: r.parts }));
  }

  /** Admin wipes a finished recording now (files and row). */
  async wipe(id: string): Promise<void> {
    const r = UUID.test(id) ? this.get(id) : null;
    if (!r || r.status === 'failed') throw new TankError('Recording not found', 404);
    if (r.status !== 'ready') throw new TankError('Stop the recording and let it finish processing first', 409);
    await this.remove(r.id);
    this.log.info({ recordingId: id }, 'recording wiped by an admin');
    this.notifyAccounts();
  }

  /* ---------------- recorder hooks ---------------- */

  /**
   * MediaMTX asks whether an action is allowed. publish: only a live recording's own key, from a
   * Tank. playback (cutting a clip): only the app itself, with its secret, for a live recording.
   */
  authorizePublish(req: RecorderAuthRequest): boolean {
    if (this.enabled && req.action === 'playback') {
      const ok = req.user === PLAYBACK_USER && sameSecret(req.password ?? '', this.playbackSecret);
      return ok && !!req.path && UUID.test(req.path) && this.get(req.path)?.status === 'recording';
    }
    if (!this.enabled || req.action !== 'publish' || req.protocol !== 'rtmp') return false;
    if (!req.path || !UUID.test(req.path) || !req.ip || !inCidr(req.ip, this.cfg.publisherCidr)) return false;
    const key = new URLSearchParams(req.query ?? '').get('key');
    const row = this.get(req.path);
    return !!key && row?.status === 'recording' && row.key_hash === sha256(key);
  }

  /** The recorder says a recording's stream went up ("ready") or down ("notready"). */
  recorderEvent(event: 'ready' | 'notready', id: string): void {
    const state = this.live.get(id);
    if (!state) return;
    if (event === 'ready') {
      state.up = true;
      state.since = Date.now();
      state.waiter?.resolve();
      return;
    }
    state.up = false;
    // Nobody asked for this (we're not stopping or restarting): the recorder restarted or the
    // network dropped. Neko still reports "broadcasting", so restart it ourselves.
    if (!state.busy && !state.waiter) void this.recover(id, 'stream dropped');
  }

  /* ---------------- background ---------------- */

  /** Startup recovery, then the watchdog/processing loop and the hourly retention sweep. */
  async startBackground(): Promise<void> {
    if (!this.enabled) return;
    await this.reconcile().catch((err) => this.log.error({ err }, 'recording reconcile failed'));
    await this.sweep().catch((err) => this.log.error({ err }, 'recording sweep failed'));
    this.timers.push(setInterval(() => void this.tick().catch((err) => this.log.error({ err }, 'recording check failed')), this.t.tickMs));
    this.timers.push(setInterval(() => void this.sweep().catch((err) => this.log.error({ err }, 'recording sweep failed')), HOUR));
    for (const t of this.timers) t.unref();
  }

  stopBackground(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * After an app restart: recordings whose Tank is still open keep going (Neko and the recorder
   * don't depend on the app), the rest end and are processed from whatever files exist.
   */
  async reconcile(now = Date.now()): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM recordings WHERE status = 'recording'").all() as unknown as RecordingRow[];
    for (const r of rows) {
      const tank = r.tank_id ? this.tanks.get(r.tank_id) : null;
      if (tank?.status === 'open' && this.tanks.credentialsFor(tank.id)?.apiToken) {
        if (!this.live.has(r.id)) this.live.set(r.id, { tankId: tank.id, up: true, since: now, restarts: 0, waiter: null, busy: false });
      } else {
        await this.stop(r.id, 'Tank gone after restart');
      }
    }
  }

  /** Watchdog for live recordings, max-length cutoff, and finishing processed ones. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, s] of [...this.live]) {
        const row = this.get(id);
        if (!row || row.status !== 'recording') {
          this.live.delete(id);
          continue;
        }
        if (now - row.started_at >= this.cfg.maxHours * HOUR) {
          await this.stop(id, 'time limit');
          continue;
        }
        if (row.stop_at !== null && now >= row.stop_at) {
          await this.stop(id, 'timer');
          continue;
        }
        if (s.busy || s.waiter) continue;
        // A stream that has stayed up a while earns its restarts back.
        if (s.up && s.restarts && now - s.since > STABLE_MS) s.restarts = 0;
        const lastWrite = await this.newestRawWrite(id);
        if (!s.up || now - Math.max(s.since, lastWrite ?? 0) > this.t.stallMs) await this.recover(id, s.up ? 'no data from the recorder' : 'stream down');
      }

      const processing = this.db.prepare("SELECT * FROM recordings WHERE status = 'processing'").all() as unknown as RecordingRow[];
      for (const r of processing) await this.finish(r, now);
    } finally {
      this.ticking = false;
    }
  }

  /** Deletes recordings past their expiry, and recorder folders that belong to no recording. */
  async sweep(now = Date.now()): Promise<void> {
    const expired = this.db
      .prepare("SELECT id FROM recordings WHERE status IN ('ready', 'failed') AND expires_at <= ?")
      .all(now) as Array<{ id: string }>;
    for (const { id } of expired) await this.remove(id);
    if (expired.length) this.log.info({ count: expired.length }, 'expired recordings wiped');

    let orphans = 0;
    for (const sub of ['ready', 'raw']) {
      for (const name of await readdir(join(this.cfg.dir, sub)).catch(() => [] as string[])) {
        if (!UUID.test(name) || this.get(name) || this.clipIds.has(name)) continue;
        await rm(join(this.cfg.dir, sub, name), { recursive: true, force: true });
        orphans++;
      }
    }
    if (orphans) this.log.warn({ count: orphans }, 'removed recording folders with no recording');
    if (expired.length || orphans) this.notifyAccounts();
  }

  /* ---------------- internals ---------------- */

  /** Starts Neko's broadcast with this key and waits for the recorder to confirm the stream. */
  private async connect(id: string, s: Live, key: string): Promise<void> {
    const token = this.tanks.credentialsFor(s.tankId)?.apiToken;
    if (!token) throw new Error('the Tank is gone');
    const url = `${this.cfg.rtmpUrl}/${id}?key=${key}`;
    let timer: NodeJS.Timeout | undefined;
    const confirmed = new Promise<void>((resolve, reject) => {
      s.waiter = { resolve, reject };
      timer = setTimeout(() => reject(new Error('the recorder did not receive the stream')), this.t.readyTimeoutMs);
    });
    confirmed.catch(() => {}); // handled below; avoids an unhandled rejection if start throws first
    try {
      try {
        await this.orch.startBroadcast(s.tankId, token, url);
      } catch (err) {
        // Neko still thinks it's broadcasting (e.g. to a recorder that restarted): reset it.
        if (!(err instanceof BroadcastError) || err.status !== 422) throw err;
        await this.orch.stopBroadcast(s.tankId, token);
        await this.orch.startBroadcast(s.tankId, token, url);
      }
      await confirmed;
      s.since = Date.now();
    } catch (err) {
      await this.orch.stopBroadcast(s.tankId, token).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
      s.waiter = null;
    }
  }

  /** Restarts a dropped stream with a new key; it becomes the recording's next part. */
  private async recover(id: string, why: string): Promise<void> {
    const s = this.live.get(id);
    if (!s || s.busy) return;
    const tank = this.tanks.get(s.tankId);
    if (tank?.status !== 'open') return; // closing: close() ends the recording
    if (s.restarts >= MAX_RESTARTS) {
      this.log.warn({ recordingId: id, why }, 'recording stream keeps dropping; ending the recording');
      await this.stop(id, 'stream kept dropping');
      return;
    }
    s.busy = true;
    s.restarts++;
    this.log.warn({ recordingId: id, tankId: s.tankId, why, attempt: s.restarts }, 'restarting recording stream');
    try {
      const token = this.tanks.credentialsFor(s.tankId)?.apiToken;
      if (token) await this.orch.stopBroadcast(s.tankId, token).catch(() => {});
      const key = newToken();
      this.db.prepare("UPDATE recordings SET key_hash = ? WHERE id = ? AND status = 'recording'").run(sha256(key), id);
      await this.connect(id, s, key);
      this.log.info({ recordingId: id }, 'recording stream resumed');
    } catch (err) {
      s.up = false;
      s.since = Date.now();
      this.log.warn({ err, recordingId: id }, 'recording stream restart failed (will retry)');
    } finally {
      s.busy = false;
    }
  }

  /** processing → ready once the recorder has remuxed every segment, or failed if nothing came. */
  private async finish(r: RecordingRow, now: number): Promise<void> {
    const raw = (await readdir(join(this.cfg.dir, 'raw', r.id)).catch(() => [] as string[])).filter((f) => f.endsWith('.mp4'));
    const ready = (await readdir(join(this.cfg.dir, 'ready', r.id)).catch(() => [] as string[])).filter((f) => PART_FILE.test(f)).sort();
    const age = now - (r.ended_at ?? now);
    const done = raw.length === 0 && (ready.length > 0 || age > 2 * MINUTE);
    if (!done && age < this.t.processTimeoutMs) return;

    if (ready.length === 0) {
      this.db
        .prepare("UPDATE recordings SET status = 'failed', expires_at = ?, error = ? WHERE id = ? AND status = 'processing'")
        .run(now, 'Nothing was recorded', r.id);
      this.log.warn({ recordingId: r.id, rawLeft: raw.length }, 'recording produced no file');
      this.notifyAccounts();
      return;
    }
    const parts: RecordingPart[] = [];
    for (const file of ready) {
      const path = join(this.cfg.dir, 'ready', r.id, file);
      const size = (await stat(path)).size;
      parts.push({ file, sizeBytes: size, durationMs: (await mp4DurationMs(path).catch(() => null)) ?? 0 });
    }
    let durationMs = parts.reduce((n, p) => n + p.durationMs, 0);
    if (!durationMs) durationMs = (r.ended_at ?? now) - r.started_at;
    const sizeBytes = parts.reduce((n, p) => n + p.sizeBytes, 0);
    this.db
      .prepare("UPDATE recordings SET status = 'ready', duration_ms = ?, size_bytes = ?, parts = ? WHERE id = ? AND status = 'processing'")
      .run(durationMs, sizeBytes, JSON.stringify(parts), r.id);
    if (raw.length) this.log.warn({ recordingId: r.id, rawLeft: raw.length }, 'recording marked ready with segments the recorder never finished');
    this.log.info({ recordingId: r.id, parts: parts.length, sizeBytes, durationMs }, 'recording ready');
    this.notifyAccounts();
  }

  private async remove(id: string): Promise<void> {
    if (!UUID.test(id)) return;
    await rm(join(this.cfg.dir, 'ready', id), { recursive: true, force: true });
    await rm(join(this.cfg.dir, 'raw', id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  }

  /** When the recorder last wrote to this recording's open segment (null = no file yet). */
  private async newestRawWrite(id: string): Promise<number | null> {
    const dir = join(this.cfg.dir, 'raw', id);
    let newest: number | null = null;
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!f.endsWith('.mp4')) continue;
      const m = await stat(join(dir, f)).then((s) => s.mtimeMs).catch(() => null);
      if (m !== null && (newest === null || m > newest)) newest = m;
    }
    return newest;
  }

  private async freeBytes(): Promise<number | null> {
    try {
      const s = await statfs(this.cfg.dir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  private notifyTank(tankId: string, event: RealtimeEvent): void {
    for (const uid of this.tanks.memberIds(tankId)) {
      this.hub.send(uid, event);
      this.hub.send(uid, { type: 'tank.updated', tankId });
    }
  }

  /** Every signed-in account (not guests) refreshes its recordings list. */
  private notifyAccounts(): void {
    const guests = new Set(
      (this.db.prepare('SELECT id FROM users WHERE guest_tank_id IS NOT NULL').all() as Array<{ id: string }>).map((r) => r.id),
    );
    const seen = new Set<string>();
    for (const c of this.hub.connections()) {
      if (seen.has(c.userId) || guests.has(c.userId)) continue;
      seen.add(c.userId);
      this.hub.send(c.userId, { type: 'recordings.changed' });
    }
  }
}

const PLAYBACK_USER = 'fishtank-app';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseParts(json: string | null): RecordingPart[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Is an IPv4 address (optionally IPv4-mapped IPv6) inside a CIDR like 10.88.2.128/25? */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw ?? 32);
  const a = ipv4(ip.replace(/^::ffff:/i, ''));
  const b = ipv4(base ?? '');
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function ipv4(s: string): number | null {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
    n = n * 256 + Number(x);
  }
  return n >>> 0;
}

/**
 * Duration of an MP4 from its movie header (moov/mvhd). The remux puts moov first
 * (+faststart), so this reads a few small headers, never the whole file.
 */
export async function mp4DurationMs(path: string): Promise<number | null> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(32);
    const box = async (at: number) => {
      const { bytesRead } = await fh.read(buf, 0, 16, at);
      if (bytesRead < 8) return null;
      let len = buf.readUInt32BE(0);
      const type = buf.toString('latin1', 4, 8);
      let header = 8;
      if (len === 1) {
        if (bytesRead < 16) return null;
        len = Number(buf.readBigUInt64BE(8));
        header = 16;
      } else if (len === 0) len = size - at;
      return len >= header ? { type, len, header } : null;
    };
    // Top level: find moov.
    let at = 0;
    let moov: { start: number; end: number } | null = null;
    for (let i = 0; i < 64 && at < size; i++) {
      const b = await box(at);
      if (!b) return null;
      if (b.type === 'moov') {
        moov = { start: at + b.header, end: at + b.len };
        break;
      }
      at += b.len;
    }
    if (!moov) return null;
    // Inside moov: find mvhd.
    for (at = moov.start; at < moov.end; ) {
      const b = await box(at);
      if (!b) return null;
      if (b.type === 'mvhd') {
        const { bytesRead } = await fh.read(buf, 0, 32, at + b.header);
        if (bytesRead < 20) return null;
        const v1 = buf[0] === 1;
        const timescale = v1 ? buf.readUInt32BE(20) : buf.readUInt32BE(12);
        const duration = v1 ? Number(buf.readBigUInt64BE(24)) : buf.readUInt32BE(16);
        return timescale ? Math.round((duration / timescale) * 1000) : null;
      }
      at += b.len;
    }
    return null;
  } finally {
    await fh.close();
  }
}
