import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.ts';
import { getOrCreateSetting, transaction, type DB } from './db.ts';
import { friendIds, getFriendship, getUserSummary, withAvatar, type InTank, type UserSummary } from './friends.ts';
import { signedAvatarUrl } from './avatars.ts';
import { endInvite, logInvite } from './invitelog.ts';
import type { NekoMember, Orchestrator, TankCredentials } from './orchestrator.ts';
import type { Hub } from './realtime.ts';
import { guestIdentity, newToken, normalizeCode, randomCode, sha256 } from './security.ts';
import { signToken, verifyToken } from './tickets.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const READY_TIMEOUT_MS = 90_000;
export const TICKET_TTL_MS = 60_000;
export const PASS_TTL_MS = 12 * HOUR;
/** A guest whose last tab closed is wiped after this long (covers page reloads and network blips). */
export const GUEST_GRACE_MS = 2 * MINUTE;
const BAD_TANK_CODE = 'That Tank invite code is invalid, used up, or expired';

export interface TankRow {
  id: string;
  name: string;
  host_id: string;
  status: 'starting' | 'open' | 'closed';
  udp_port: number;
  container_id: string | null;
  created_at: number;
  last_active_at: number;
  expires_at: number;
  closed_at: number | null;
  close_reason: string | null;
  friends_can_join: number;
}

export type TankRole = 'host' | 'guest';

/** An expected failure with an HTTP status, surfaced to the client as { error }. */
export class TankError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface TankServiceDeps {
  config: Config;
  db: DB;
  hub: Hub;
  orchestrator: Orchestrator;
  log: FastifyBaseLogger;
}

/**
 * Owns the Tank lifecycle: creating containers, tracking who is watching, closing idle or
 * expired Tanks, reconciling with Docker, and membership/invites/access tokens.
 */
export class TankService {
  private cfg: Config['tanks'];
  private publicUrl: string;
  private db: DB;
  private hub: Hub;
  private orch: Orchestrator;
  private log: FastifyBaseLogger;
  private secret: string;
  /** Neko passwords per live Tank (memory only; recoverable from the container's env). */
  private creds = new Map<string, TankCredentials>();
  /** tankId → userId → number of open tabs viewing it. */
  private viewers = new Map<string, Map<string, number>>();
  /** Tanks whose container is being created right now (reconcile must not touch them). */
  private starting = new Set<string>();
  /** Latest screen preview per live Tank (memory only; dies with the Tank). */
  private previews = new Map<string, { jpeg: Buffer; at: number }>();
  private capturing = false;
  private captures = new Map<string, Promise<void>>();
  /** tankId → users who already have a Neko login there (saves an API call per page load). */
  private nekoMembers = new Map<string, Set<string>>();
  /** Guest userId → when they were first seen with no open tab. */
  private guestOfflineSince = new Map<string, number>();
  /** Nonces of tickets already exchanged (kept until they'd have expired anyway). */
  private usedTickets = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  constructor(deps: TankServiceDeps) {
    this.cfg = deps.config.tanks;
    this.publicUrl = deps.config.publicUrl;
    this.db = deps.db;
    this.hub = deps.hub;
    this.orch = deps.orchestrator;
    this.log = deps.log;
    this.secret = getOrCreateSetting(this.db, 'tank_token_secret', () => randomBytes(32).toString('base64url'));
  }

  /* ---------------- queries ---------------- */

  get(id: string): TankRow | null {
    return (this.db.prepare('SELECT * FROM tanks WHERE id = ?').get(id) as TankRow | undefined) ?? null;
  }

  role(tankId: string, userId: string): TankRole | null {
    const r = this.db.prepare('SELECT role FROM tank_members WHERE tank_id = ? AND user_id = ?').get(tankId, userId) as
      | { role: TankRole }
      | undefined;
    return r?.role ?? null;
  }

  /** Member of a Tank that is open (container ready), with an enabled account. */
  canAccess(tankId: string, userId: string): boolean {
    const t = this.get(tankId);
    if (!t || t.status !== 'open' || this.role(tankId, userId) === null) return false;
    const u = this.db.prepare('SELECT disabled FROM users WHERE id = ?').get(userId) as { disabled: number } | undefined;
    return !!u && !u.disabled;
  }

  memberIds(tankId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM tank_members WHERE tank_id = ?').all(tankId) as Array<{ user_id: string }>).map(
      (r) => r.user_id,
    );
  }

  viewersOf(tankId: string): string[] {
    return [...(this.viewers.get(tankId)?.keys() ?? [])];
  }

  /**
   * The Tank a friend is watching right now, as `viewerId` may see it: the name and id only if
   * they're a member or the Tank is open to them as a friend of its host, otherwise just "in a Tank".
   */
  watchingFor(viewerId: string, friendId: string): InTank {
    let fallback: InTank = null;
    for (const [tankId, users] of this.viewers) {
      if (!users.has(friendId)) continue;
      const tank = this.get(tankId);
      if (tank && (this.role(tankId, viewerId) || this.visibleToFriend(tank, viewerId))) return { id: tank.id, name: tank.name };
      fallback = { id: null, name: null };
    }
    return fallback;
  }

  credentialsFor(tankId: string): TankCredentials | null {
    return this.creds.get(tankId) ?? null;
  }

  /** Live Tanks the user belongs to. */
  listFor(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.status, t.created_at AS createdAt, t.expires_at AS expiresAt, m.role,
                h.id AS hostId, h.username AS hostUsername, h.display_name AS hostDisplayName,
                (SELECT COUNT(*) FROM tank_members x WHERE x.tank_id = t.id) AS memberCount
         FROM tanks t
         JOIN tank_members m ON m.tank_id = t.id AND m.user_id = ?
         JOIN users h ON h.id = t.host_id
         WHERE t.status != 'closed'
         ORDER BY t.created_at DESC`,
      )
      .all(userId) as Array<Record<string, unknown> & { id: string }>;
    return rows.map((r) => ({ ...r, viewerCount: this.viewersOf(r.id).length, previewAt: this.previewAt(r.id) }));
  }

  /**
   * Live Tanks hosted by the user's friends that they haven't joined yet, where the host lets
   * friends drop in. Blocking removes the friendship, so blocked users never see these.
   */
  friendsTanksFor(userId: string) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.status, t.created_at AS createdAt, t.expires_at AS expiresAt,
                h.id AS hostId, h.username AS hostUsername, h.display_name AS hostDisplayName, h.avatar_version AS avatarVersion,
                (SELECT COUNT(*) FROM tank_members x WHERE x.tank_id = t.id) AS memberCount
         FROM tanks t
         JOIN users h ON h.id = t.host_id AND h.disabled = 0
         JOIN friendships f ON f.status = 'accepted'
           AND f.user_low_id = MIN(t.host_id, :me) AND f.user_high_id = MAX(t.host_id, :me)
         WHERE t.status != 'closed' AND t.friends_can_join = 1
           AND NOT EXISTS (SELECT 1 FROM tank_members m WHERE m.tank_id = t.id AND m.user_id = :me)
         ORDER BY t.created_at DESC`,
      )
      .all({ me: userId }) as Array<Record<string, unknown> & { id: string; hostId: string; avatarVersion: number | null }>;
    return rows.map(({ avatarVersion, ...r }) => ({
      ...r,
      hostAvatarUrl: withAvatar({ id: r.hostId, avatarVersion }).avatarUrl,
      viewerCount: this.viewersOf(r.id).length,
      previewAt: this.previewAt(r.id),
    }));
  }

  members(tankId: string) {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, u.avatar_version AS avatarVersion, m.role, m.joined_at AS joinedAt,
                u.guest_tank_id IS NOT NULL AS isGuest
         FROM tank_members m JOIN users u ON u.id = m.user_id
         WHERE m.tank_id = ? ORDER BY m.role = 'host' DESC, m.joined_at`,
      )
      .all(tankId) as unknown as Array<UserSummary & { role: TankRole; joinedAt: number; avatarVersion: number | null; isGuest: number }>;
    const watching = new Set(this.viewersOf(tankId));
    return rows.map((r) => ({ ...withAvatar(r), isGuest: !!r.isGuest, watching: watching.has(r.id), online: this.hub.isOnline(r.id) }));
  }

  /* ---------------- lifecycle ---------------- */

  create(hostId: string, name: string): TankRow {
    const id = randomUUID();
    const now = Date.now();
    transaction(this.db, () => {
      const live = this.db.prepare("SELECT host_id, udp_port FROM tanks WHERE status != 'closed'").all() as Array<{
        host_id: string;
        udp_port: number;
      }>;
      if (live.filter((t) => t.host_id === hostId).length >= this.cfg.maxPerHost) {
        throw new TankError(
          this.cfg.maxPerHost === 1 ? 'You already have a Tank open. Drain it before starting another.' : 'You have too many Tanks open.',
          409,
        );
      }
      if (live.length >= this.cfg.maxTanks) throw new TankError('All Tanks are in use right now. Try again later.', 503);

      const used = new Set(live.map((t) => t.udp_port));
      let port = -1;
      for (let p = this.cfg.portRange[0]; p <= this.cfg.portRange[1]; p++) {
        if (!used.has(p)) {
          port = p;
          break;
        }
      }
      if (port < 0) throw new TankError('No free media ports. Try again later.', 503);

      this.db
        .prepare(
          `INSERT INTO tanks (id, name, host_id, status, udp_port, created_at, last_active_at, expires_at)
           VALUES (?, ?, ?, 'starting', ?, ?, ?, ?)`,
        )
        .run(id, name, hostId, port, now, now, now + this.cfg.maxHours * HOUR);
      this.db.prepare("INSERT INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'host', ?)").run(id, hostId, now);
    });

    const tank = this.get(id)!;
    this.notifyHostFriends(hostId);
    this.starting.add(id);
    void this.startContainer(tank);
    return tank;
  }

  private async startContainer(tank: TankRow): Promise<void> {
    const apiToken = newToken();
    this.creds.set(tank.id, { apiToken });
    try {
      const containerId = await this.orch.start({ id: tank.id, udpPort: tank.udp_port, name: tank.name, apiToken });
      this.db.prepare('UPDATE tanks SET container_id = ? WHERE id = ?').run(containerId, tank.id);
      await this.orch.waitReady(tank.id, READY_TIMEOUT_MS);
      const res = this.db
        .prepare("UPDATE tanks SET status = 'open', last_active_at = ? WHERE id = ? AND status = 'starting'")
        .run(Date.now(), tank.id);
      if (res.changes === 1) {
        this.log.info({ tankId: tank.id, port: tank.udp_port }, 'tank open');
        this.notify(tank.id, { type: 'tank.updated', tankId: tank.id });
      }
    } catch (err) {
      this.log.error({ err, tankId: tank.id }, 'tank failed to start');
      await this.close(tank.id, 'failed to start');
    } finally {
      this.starting.delete(tank.id);
    }
  }

  /** Closes a Tank and destroys its container. Returns false if it was already closed. */
  async close(tankId: string, reason: string): Promise<boolean> {
    const tank = this.get(tankId);
    if (!tank || tank.status === 'closed') return false;
    const res = this.db
      .prepare("UPDATE tanks SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ? AND status != 'closed'")
      .run(Date.now(), reason, tankId);
    if (res.changes !== 1) return false;

    this.log.info({ tankId, reason }, 'tank closed');
    this.notify(tankId, { type: 'tank.closed', tankId, name: tank.name, reason });
    this.creds.delete(tankId);
    this.nekoMembers.delete(tankId);
    const guests = this.db.prepare('SELECT id FROM users WHERE guest_tank_id = ?').all(tankId) as Array<{ id: string }>;
    for (const g of guests) await this.wipeGuest(g.id, 'Tank drained');
    const watchers = this.viewersOf(tankId);
    this.viewers.delete(tankId);
    for (const uid of watchers) this.notifyActivity(uid);
    this.previews.delete(tankId);
    for (const c of this.hub.connections()) if (c.tankId === tankId) c.tankId = undefined;
    try {
      await this.orch.destroy(tankId);
    } catch (err) {
      this.log.error({ err, tankId }, 'failed to remove tank container (reconcile will retry)');
    }
    return true;
  }

  /** Closes idle and expired Tanks; keeps watched Tanks marked active. */
  async reap(now = Date.now()): Promise<void> {
    const open = this.db.prepare("SELECT id, last_active_at, expires_at FROM tanks WHERE status = 'open'").all() as Array<{
      id: string;
      last_active_at: number;
      expires_at: number;
    }>;
    for (const t of open) {
      if (now >= t.expires_at) {
        await this.close(t.id, 'time limit');
      } else if (this.viewersOf(t.id).length > 0) {
        this.db.prepare('UPDATE tanks SET last_active_at = ? WHERE id = ?').run(now, t.id);
      } else if (now - t.last_active_at >= this.cfg.idleMinutes * MINUTE) {
        await this.close(t.id, 'idle');
      }
    }
  }

  /**
   * Makes Docker and the database agree: removes containers with no live Tank, closes live
   * Tanks with no running container, and recovers Neko passwords after an app restart.
   */
  async reconcile(): Promise<void> {
    const containers = await this.orch.list();
    const byTank = new Map(containers.map((c) => [c.tankId, c]));

    for (const c of containers) {
      if (this.starting.has(c.tankId)) continue;
      const tank = this.get(c.tankId);
      if (!tank || tank.status === 'closed') {
        this.log.warn({ tankId: c.tankId }, 'removing orphaned tank container');
        await this.orch.destroy(c.tankId).catch((err) => this.log.error({ err }, 'orphan removal failed'));
      }
    }

    const live = this.db.prepare("SELECT id, status FROM tanks WHERE status != 'closed'").all() as Array<{ id: string; status: string }>;
    for (const t of live) {
      if (this.starting.has(t.id)) continue;
      const c = byTank.get(t.id);
      if (!c || !c.running) {
        await this.close(t.id, c ? 'container stopped' : 'container missing');
        continue;
      }
      if (!this.creds.has(t.id)) {
        const creds = await this.orch.credentials(t.id);
        if (creds) this.creds.set(t.id, creds);
        else await this.close(t.id, 'credentials lost');
      }
      if (t.status === 'starting' && this.creds.has(t.id)) {
        // App restarted mid-start: the container is running, so finish opening it.
        this.db.prepare("UPDATE tanks SET status = 'open', last_active_at = ? WHERE id = ? AND status = 'starting'").run(Date.now(), t.id);
      }
    }
  }

  /** Starts the background loops: reaper every minute, reconcile every 5 minutes. */
  async startBackground(): Promise<void> {
    // Give Tanks that survived a restart a fresh idle window.
    this.db.prepare("UPDATE tanks SET last_active_at = ? WHERE status = 'open'").run(Date.now());
    await this.orch.ensureImage().catch((err) => this.log.error({ err }, 'could not pull tank image'));
    // Keep the Tank browser patched: refresh the image now (in the background) and daily.
    const refresh = () =>
      this.orch
        .pullImage()
        .then(() => this.log.info('tank image refreshed'))
        .catch((err) => this.log.warn({ err }, 'tank image refresh failed'));
    void refresh();
    this.timers.push(setInterval(refresh, 24 * 60 * MINUTE));
    await this.reconcile().catch((err) => this.log.error({ err }, 'reconcile failed'));
    const safe = (fn: () => Promise<void>, what: string) => () => void fn().catch((err) => this.log.error({ err }, `${what} failed`));
    this.timers.push(setInterval(safe(() => this.reap(), 'reap'), MINUTE));
    this.timers.push(setInterval(safe(() => this.reconcile(), 'reconcile'), 5 * MINUTE));
    // Checked every 30s so a new Tank gets its first preview soon after opening.
    this.timers.push(setInterval(safe(() => this.refreshPreviews(), 'preview'), 30_000));
    this.timers.push(setInterval(safe(() => this.sweepGuests(), 'guest sweep'), 30_000));
    for (const t of this.timers) t.unref();
  }

  stopBackground(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /* ---------------- viewers ---------------- */

  /** A tab started viewing a Tank. Returns false if the user can't access it. */
  join(tankId: string, userId: string): boolean {
    if (!this.canAccess(tankId, userId)) return false;
    let m = this.viewers.get(tankId);
    if (!m) this.viewers.set(tankId, (m = new Map()));
    const before = m.size;
    m.set(userId, (m.get(userId) ?? 0) + 1);
    this.db.prepare('UPDATE tanks SET last_active_at = ? WHERE id = ?').run(Date.now(), tankId);
    if (m.size !== before) {
      this.notify(tankId, { type: 'tank.updated', tankId });
      this.notifyActivity(userId);
    }
    return true;
  }

  leave(tankId: string, userId: string): void {
    const m = this.viewers.get(tankId);
    const n = m?.get(userId);
    if (!m || !n) return;
    if (n > 1) return void m.set(userId, n - 1);
    m.delete(userId);
    this.db.prepare('UPDATE tanks SET last_active_at = ? WHERE id = ?').run(Date.now(), tankId);
    this.notify(tankId, { type: 'tank.updated', tankId });
    this.notifyActivity(userId);
  }

  /* ---------------- previews ---------------- */

  previewAt(tankId: string): number | null {
    return this.previews.get(tankId)?.at ?? null;
  }

  /** The Tank's latest screenshot, for its members and for friends who can see it. */
  previewFor(tankId: string, userId: string): Buffer | null {
    const p = this.previews.get(tankId);
    if (!p) return null;
    const tank = this.get(tankId);
    if (!tank || tank.status === 'closed') return null;
    return this.role(tankId, userId) || this.visibleToFriend(tank, userId) ? p.jpeg : null;
  }

  /** Captures a screenshot of every open Tank whose preview is missing or older than the interval. */
  async refreshPreviews(now = Date.now()): Promise<void> {
    if (!this.cfg.previewMinutes || this.capturing) return;
    this.capturing = true;
    try {
      const open = this.db.prepare("SELECT id FROM tanks WHERE status = 'open'").all() as Array<{ id: string }>;
      for (const { id } of open) {
        const last = this.previews.get(id)?.at ?? 0;
        if (now - last >= this.cfg.previewMinutes * MINUTE) await this.capture(id);
      }
    } finally {
      this.capturing = false;
    }
  }

  /** One screenshot now; concurrent calls for the same Tank share it. */
  private capture(tankId: string): Promise<void> {
    const running = this.captures.get(tankId);
    if (running) return running;
    const p = (async () => {
      const token = this.creds.get(tankId)?.apiToken;
      if (!token) return;
      const jpeg = await this.orch.screenshot(tankId, token).catch((err) => {
        this.log.warn({ err, tankId }, 'tank screenshot failed');
        return null;
      });
      if (!jpeg || this.get(tankId)?.status !== 'open') return;
      this.previews.set(tankId, { jpeg, at: Date.now() });
      this.notify(tankId, { type: 'tank.updated', tankId });
    })().finally(() => this.captures.delete(tankId));
    this.captures.set(tankId, p);
    return p;
  }

  /**
   * Link-preview info for a TANK- invite code (Discord etc. fetch this without logging in).
   * Holding the code already lets you join, so it may also see the screen. Captures a
   * preview on demand if the Tank doesn't have one yet (e.g. a link shared right after opening).
   */
  async shareInfo(code: string) {
    const found = this.findCode(code);
    const tank = found && this.get(found.tankId);
    if (!tank || tank.status === 'closed') return null;
    if (tank.status === 'open' && this.cfg.previewMinutes && !this.previews.has(tank.id)) await this.capture(tank.id);
    return {
      tankId: tank.id,
      name: tank.name,
      status: tank.status,
      host: getUserSummary(this.db, tank.host_id)?.displayName ?? 'Someone',
      viewerCount: this.viewersOf(tank.id).length,
      previewAt: this.previewAt(tank.id),
    };
  }

  /** Tank name and host for the join page (no login needed; the code is the secret). */
  codeInfo(code: string): { tankName: string; host: string } | null {
    const found = this.findCode(code);
    const tank = found && this.get(found.tankId);
    if (!tank) return null;
    return { tankName: tank.name, host: getUserSummary(this.db, tank.host_id)?.displayName ?? 'Someone' };
  }

  /** The preview image for a valid TANK- invite code. */
  previewForCode(code: string): Buffer | null {
    const found = this.findCode(code);
    return found && this.get(found.tankId)?.status === 'open' ? (this.previews.get(found.tankId)?.jpeg ?? null) : null;
  }

  /* ---------------- membership & invites ---------------- */

  private requireLive(tankId: string): TankRow {
    const t = this.get(tankId);
    if (!t || t.status === 'closed') throw new TankError('That Tank has been drained', 404);
    return t;
  }

  private addMember(tankId: string, userId: string): void {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO tank_members (tank_id, user_id, role, joined_at) VALUES (?, ?, 'guest', ?)")
      .run(tankId, userId, Date.now());
    if (res.changes) this.notify(tankId, { type: 'tank.updated', tankId });
  }

  /** Live Tank that this friend of the host may see in "Friends' Tanks" and drop in to. */
  private visibleToFriend(tank: TankRow | null, userId: string): boolean {
    return !!tank && tank.status !== 'closed' && !!tank.friends_can_join && getFriendship(this.db, tank.host_id, userId)?.status === 'accepted';
  }

  /** A friend of the host joins a Tank that lets friends drop in. Returns the Tank id. */
  joinAsFriend(tankId: string, userId: string): string {
    if (this.role(tankId, userId)) return tankId;
    // One message for every refusal, so Tank ids can't be probed.
    if (!this.visibleToFriend(this.get(tankId), userId)) throw new TankError('Tank not found', 404);
    this.addMember(tankId, userId);
    return tankId;
  }

  /** Host decides whether their friends can see this Tank and drop in without an invite. */
  setFriendsCanJoin(tankId: string, hostId: string, allowed: boolean): void {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can change this', 403);
    this.db.prepare('UPDATE tanks SET friends_can_join = ? WHERE id = ?').run(allowed ? 1 : 0, tankId);
    this.notify(tankId, { type: 'tank.updated', tankId });
  }

  /** Host invites friends directly; they get a live notification and an inbox entry. */
  inviteFriends(tankId: string, hostId: string, userIds: string[]): number {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can invite people', 403);
    const by = getUserSummary(this.db, hostId);
    let invited = 0;
    for (const uid of new Set(userIds)) {
      if (getFriendship(this.db, hostId, uid)?.status !== 'accepted') continue; // friends only
      if (this.role(tankId, uid)) continue; // already in
      const id = randomUUID();
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO tank_invites (id, tank_id, created_by, kind, invited_user_id, created_at, expires_at)
           VALUES (?, ?, ?, 'direct', ?, ?, ?)`,
        )
        .run(id, tankId, hostId, uid, Date.now(), tank.expires_at);
      if (res.changes) {
        invited++;
        this.hub.send(uid, { type: 'tank.invite', invite: { id, tank: { id: tankId, name: tank.name }, by } });
      }
    }
    return invited;
  }

  /** Users with a pending direct invite to this Tank (for the host's invite picker). */
  pendingInviteeIds(tankId: string): string[] {
    return (
      this.db
        .prepare("SELECT invited_user_id AS id FROM tank_invites WHERE tank_id = ? AND kind = 'direct' AND revoked_at IS NULL")
        .all(tankId) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  invitesFor(userId: string) {
    return this.db
      .prepare(
        `SELECT i.id, i.created_at AS createdAt, t.id AS tankId, t.name AS tankName, t.status AS tankStatus,
                u.id AS byId, u.username AS byUsername, u.display_name AS byDisplayName
         FROM tank_invites i
         JOIN tanks t ON t.id = i.tank_id
         LEFT JOIN users u ON u.id = i.created_by
         WHERE i.kind = 'direct' AND i.invited_user_id = ? AND i.revoked_at IS NULL
           AND t.status != 'closed' AND i.expires_at > ?
         ORDER BY i.created_at DESC`,
      )
      .all(userId, Date.now());
  }

  /** Accept (join) or decline a direct invite. Returns the Tank id on accept. */
  respondToInvite(inviteId: string, userId: string, accept: boolean): string {
    const inv = this.db
      .prepare("SELECT tank_id FROM tank_invites WHERE id = ? AND kind = 'direct' AND invited_user_id = ? AND revoked_at IS NULL")
      .get(inviteId, userId) as { tank_id: string } | undefined;
    if (!inv) throw new TankError('Invite not found', 404);
    this.db.prepare('DELETE FROM tank_invites WHERE id = ?').run(inviteId);
    if (!accept) return inv.tank_id;
    this.requireLive(inv.tank_id);
    this.addMember(inv.tank_id, userId);
    return inv.tank_id;
  }

  /** Host generates a shareable TANK- code (works for existing users and for sign-up). */
  createCode(tankId: string, hostId: string, opts: { maxUses: number; expiresInHours?: number }) {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can create invite codes', 403);
    const code = randomCode('TANK');
    const id = randomUUID();
    const expiresAt = Math.min(tank.expires_at, Date.now() + (opts.expiresInHours ?? this.cfg.maxHours) * HOUR);
    this.db
      .prepare(
        `INSERT INTO tank_invites (id, tank_id, created_by, kind, code_hash, code_hint, max_uses, created_at, expires_at)
         VALUES (?, ?, ?, 'code', ?, ?, ?, ?, ?)`,
      )
      .run(id, tankId, hostId, sha256(normalizeCode(code)), code.slice(-4), opts.maxUses, Date.now(), expiresAt);
    return { id, code, expiresAt, maxUses: opts.maxUses };
  }

  /** The host's invite links for a Tank that still work (not revoked, used up or expired). */
  listCodes(tankId: string, hostId: string) {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can see invite links', 403);
    return this.db
      .prepare(
        `SELECT id, code_hint AS hint, max_uses AS maxUses, uses, created_at AS createdAt, expires_at AS expiresAt
         FROM tank_invites WHERE tank_id = ? AND kind = 'code' AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(tankId, Date.now());
  }

  /**
   * Host cancels an invite link: it stops working for joining, sign-up and link previews at
   * once. People who already joined with it stay (the host can remove them separately).
   */
  revokeCode(tankId: string, hostId: string, inviteId: string): void {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can revoke invite links', 403);
    const res = this.db
      .prepare("UPDATE tank_invites SET revoked_at = ? WHERE id = ? AND tank_id = ? AND kind = 'code' AND revoked_at IS NULL")
      .run(Date.now(), inviteId, tankId);
    if (res.changes !== 1) throw new TankError('Invite link not found', 404);
  }

  /** Looks up a usable TANK- code. */
  findCode(code: string): { inviteId: string; tankId: string; createdBy: string | null } | null {
    const r = this.db
      .prepare(
        `SELECT i.id AS inviteId, i.tank_id AS tankId, i.created_by AS createdBy FROM tank_invites i JOIN tanks t ON t.id = i.tank_id
         WHERE i.kind = 'code' AND i.code_hash = ? AND i.revoked_at IS NULL AND i.uses < i.max_uses
           AND i.expires_at > ? AND t.status != 'closed'`,
      )
      .get(sha256(normalizeCode(code)), Date.now()) as { inviteId: string; tankId: string; createdBy: string | null } | undefined;
    return r ?? null;
  }

  /** Redeems a TANK- code for a user. Existing members don't consume a use. Returns the Tank id. */
  redeemCode(code: string, userId: string): string {
    const found = this.findCode(code);
    if (!found) throw new TankError(BAD_TANK_CODE, 404);
    if (this.role(found.tankId, userId)) return found.tankId;
    const claimed = this.db.prepare('UPDATE tank_invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses').run(found.inviteId);
    if (claimed.changes !== 1) throw new TankError(BAD_TANK_CODE, 404);
    this.addMember(found.tankId, userId);
    return found.tankId;
  }

  /** A guest leaves (the host drains instead). */
  async leaveTank(tankId: string, userId: string): Promise<void> {
    const role = this.role(tankId, userId);
    if (!role) throw new TankError('Not a member', 404);
    if (role === 'host') throw new TankError('The host can drain the Tank instead of leaving', 400);
    if (await this.wipeGuest(userId, 'left')) return;
    await this.dropMember(tankId, userId);
  }

  /** Host removes a guest: membership, pending invites, live viewing, and their Neko session. */
  async removeMember(tankId: string, hostId: string, userId: string): Promise<void> {
    const tank = this.requireLive(tankId);
    if (tank.host_id !== hostId) throw new TankError('Only the host can remove people', 403);
    if (userId === hostId) throw new TankError("You can't remove yourself. Drain the Tank instead.", 400);
    if (!this.role(tankId, userId)) throw new TankError('Not a member', 404);
    this.hub.send(userId, { type: 'tank.removed', tankId, name: tank.name });
    if (await this.wipeGuest(userId, 'removed by host')) return;
    await this.dropMember(tankId, userId);
  }

  /** Admin disabled an account: drain the Tanks they host, remove them from the others. */
  async evictUser(userId: string): Promise<void> {
    if (await this.wipeGuest(userId, 'disabled by an admin')) return;
    const rows = this.db
      .prepare("SELECT t.id, m.role FROM tank_members m JOIN tanks t ON t.id = m.tank_id WHERE m.user_id = ? AND t.status != 'closed'")
      .all(userId) as Array<{ id: string; role: TankRole }>;
    for (const r of rows) {
      if (r.role === 'host') await this.close(r.id, 'host account disabled');
      else await this.dropMember(r.id, userId);
    }
  }

  /** Every live Tank with host, members, viewers and resource usage (admin dashboard). */
  async adminOverview() {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.status, t.udp_port AS udpPort, t.created_at AS createdAt, t.expires_at AS expiresAt,
                t.last_active_at AS lastActiveAt, u.username AS hostUsername, u.display_name AS hostDisplayName,
                (SELECT COUNT(*) FROM tank_members m WHERE m.tank_id = t.id) AS memberCount
         FROM tanks t JOIN users u ON u.id = t.host_id WHERE t.status != 'closed' ORDER BY t.created_at`,
      )
      .all() as Array<Record<string, unknown> & { id: string }>;
    return Promise.all(
      rows.map(async (r) => ({ ...r, viewerCount: this.viewersOf(r.id).length, stats: await this.orch.stats(r.id) })),
    );
  }

  private async dropMember(tankId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM tank_members WHERE tank_id = ? AND user_id = ?').run(tankId, userId);
    this.db.prepare("DELETE FROM tank_invites WHERE tank_id = ? AND kind = 'direct' AND invited_user_id = ?").run(tankId, userId);
    if (this.viewers.get(tankId)?.delete(userId)) this.notifyActivity(userId);
    for (const c of this.hub.connections()) if (c.userId === userId && c.tankId === tankId) c.tankId = undefined;
    this.notify(tankId, { type: 'tank.updated', tankId });

    // Their pass cookie stops working at once (membership is checked per request), but an
    // already-open Neko connection would keep streaming, so end it through Neko's API too.
    const creds = this.creds.get(tankId);
    const username = getUserSummary(this.db, userId)?.username;
    this.nekoMembers.get(tankId)?.delete(userId);
    if (creds?.apiToken && username) {
      try {
        if (creds.userPassword) await this.orch.disconnectUser(tankId, username, creds.apiToken);
        else await this.orch.removeMember(tankId, creds.apiToken, username);
      } catch (err) {
        this.log.warn({ err, tankId }, 'could not disconnect removed member from neko');
      }
    }
  }

  /* ---------------- guests ---------------- */

  /**
   * Someone without an account opens a TANK- invite link: make a temporary guest with a random
   * name, bound to this one Tank (watch only), and use up one use of the code.
   */
  joinAsGuest(code: string): { userId: string; tankId: string; expiresAt: number } {
    const found = this.findCode(code);
    const tank = found && this.get(found.tankId);
    if (!found || !tank) throw new TankError(BAD_TANK_CODE, 404);
    return transaction(this.db, () => {
      let ident = guestIdentity();
      for (let i = 0; i < 5 && this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(ident.username); i++) ident = guestIdentity();
      const userId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, role, created_at, guest_tank_id, invited_by)
           VALUES (?, ?, ?, '!', 'member', ?, ?, ?)`,
        )
        .run(userId, ident.username, ident.displayName, Date.now(), tank.id, found.createdBy);
      this.redeemCode(code, userId); // claims a use and adds them; throws (rolling back) if used up meanwhile
      logInvite(this.db, { kind: 'guest', userId, userName: ident.displayName, invitedBy: found.createdBy, tankName: tank.name });
      return { userId, tankId: tank.id, expiresAt: tank.expires_at };
    });
  }

  /** Deletes a guest and everything about them, and ends their tabs. Returns false if not a guest. */
  async wipeGuest(userId: string, reason: string): Promise<boolean> {
    const g = this.db.prepare('SELECT guest_tank_id AS tankId FROM users WHERE id = ? AND guest_tank_id IS NOT NULL').get(userId) as
      | { tankId: string }
      | undefined;
    if (!g) return false;
    endInvite(this.db, userId, reason);
    if (this.get(g.tankId)?.status !== 'closed') await this.dropMember(g.tankId, userId);
    this.guestOfflineSince.delete(userId);
    this.hub.closeUser(userId, `guest:${reason}`);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    this.log.info({ tankId: g.tankId, reason }, 'guest wiped');
    return true;
  }

  /** Wipes guests who have had no open tab for GUEST_GRACE_MS. Runs every 30 seconds. */
  async sweepGuests(now = Date.now()): Promise<void> {
    const guests = this.db
      .prepare('SELECT u.id, t.status FROM users u JOIN tanks t ON t.id = u.guest_tank_id')
      .all() as Array<{ id: string; status: TankRow['status'] }>;
    for (const { id, status } of guests) {
      const since = this.guestOfflineSince.get(id);
      if (status === 'closed') await this.wipeGuest(id, 'Tank drained'); // e.g. the app stopped mid-close
      else if (this.hub.isOnline(id)) this.guestOfflineSince.delete(id);
      else if (since === undefined) this.guestOfflineSince.set(id, now);
      else if (now - since >= GUEST_GRACE_MS) await this.wipeGuest(id, 'disconnected');
    }
  }

  /* ---------------- Neko logins ---------------- */

  /**
   * The Neko username/password this person uses inside the Tank. Current Tanks get a personal
   * login (created on first use) whose permissions follow their role: host = Neko admin,
   * account = can be handed control, guest = watch only. The password is derived, never stored.
   */
  async nekoLogin(tankId: string, userId: string): Promise<{ username: string; password: string } | null> {
    const creds = this.creds.get(tankId);
    const u = this.db
      .prepare('SELECT username, display_name AS displayName, guest_tank_id AS guestTankId, avatar_version AS avatarVersion FROM users WHERE id = ?')
      .get(userId) as { username: string; displayName: string; guestTankId: string | null; avatarVersion: number | null } | undefined;
    const role = this.role(tankId, userId);
    if (!creds || !u || !role) return null;
    if (creds.userPassword && creds.adminPassword) {
      return { username: u.username, password: role === 'host' ? creds.adminPassword : creds.userPassword }; // legacy Tank
    }
    if (!creds.apiToken) return null;
    const password = createHmac('sha256', this.secret).update(`neko:${tankId}:${userId}`).digest('base64url');
    let done = this.nekoMembers.get(tankId);
    if (!done) this.nekoMembers.set(tankId, (done = new Set()));
    if (!done.has(userId)) {
      await this.orch.ensureMember(tankId, creds.apiToken, this.nekoMember(tankId, userId, password)!);
      done.add(userId);
    }
    return { username: u.username, password };
  }

  /**
   * Signs a member in to the Tank's Neko from the server. Current Tanks: returns Neko's session
   * cookie value, so the password never reaches the browser. Older Tanks (no cookie sessions):
   * returns the username/password for the Neko page to log in with.
   */
  async nekoSession(tankId: string, userId: string): Promise<{ cookie: string } | { usr: string; pwd: string } | null> {
    const login = await this.nekoLogin(tankId, userId);
    if (!login) return null;
    if (this.creds.get(tankId)?.userPassword) return { usr: login.username, pwd: login.password };
    const token = await this.orch.login(tankId, login.username, login.password);
    return token ? { cookie: token } : { usr: login.username, pwd: login.password };
  }

  /** The Neko login for a member of a Tank, from their current account details. */
  private nekoMember(tankId: string, userId: string, password = ''): NekoMember | null {
    const u = this.db
      .prepare('SELECT username, display_name AS displayName, guest_tank_id AS guestTankId, avatar_version AS avatarVersion FROM users WHERE id = ?')
      .get(userId) as { username: string; displayName: string; guestTankId: string | null; avatarVersion: number | null } | undefined;
    const role = this.role(tankId, userId);
    if (!u || !role) return null;
    return {
      username: u.username,
      password,
      displayName: u.displayName,
      avatarUrl: signedAvatarUrl(this.db, this.publicUrl, userId, u.avatarVersion),
      kind: role === 'host' ? 'host' : u.guestTankId ? 'guest' : 'member',
    };
  }

  /** Someone changed their avatar: update their Neko profile in every live Tank they've opened. */
  async refreshNekoProfile(userId: string): Promise<void> {
    for (const [tankId, users] of this.nekoMembers) {
      const token = this.creds.get(tankId)?.apiToken;
      const m = users.has(userId) && token ? this.nekoMember(tankId, userId) : null;
      if (!m || !token) continue;
      await this.orch.updateMember(tankId, token, m).catch((err) => this.log.warn({ err, tankId }, 'could not update neko profile'));
    }
  }

  /* ---------------- Tank-origin access tokens ---------------- */

  issueTicket(tankId: string, userId: string): string {
    return signToken(this.secret, { k: 'ticket', t: tankId, u: userId, e: Date.now() + TICKET_TTL_MS, n: randomBytes(12).toString('base64url') });
  }

  issuePass(tankId: string, userId: string): string {
    return signToken(this.secret, { k: 'pass', t: tankId, u: userId, e: Date.now() + PASS_TTL_MS });
  }

  /** Valid, unused ticket for a member → their user id. Each ticket works once. */
  checkTicket(tankId: string, ticket: string | undefined): string | null {
    const t = verifyToken(this.secret, ticket, 'ticket', tankId);
    if (!t?.n || !this.canAccess(tankId, t.u)) return null;
    const now = Date.now();
    for (const [n, exp] of this.usedTickets) if (exp <= now) this.usedTickets.delete(n);
    if (this.usedTickets.has(t.n)) return null;
    this.usedTickets.set(t.n, t.e);
    return t.u;
  }

  checkPass(tankId: string, pass: string | undefined): string | null {
    const t = verifyToken(this.secret, pass, 'pass', tankId);
    return t && this.canAccess(tankId, t.u) ? t.u : null;
  }

  /* ---------------- helpers ---------------- */

  private notify(tankId: string, event: Parameters<Hub['send']>[1]): void {
    for (const uid of this.memberIds(tankId)) this.hub.send(uid, event);
    const host = this.get(tankId)?.host_id;
    if (host) this.notifyHostFriends(host);
  }

  /** Tells the user's friends that their "in a Tank" status changed. */
  private notifyActivity(userId: string): void {
    for (const uid of friendIds(this.db, userId)) this.hub.send(uid, { type: 'friends.activity', userId });
  }

  /** Tells the host's friends to refresh their "Friends' Tanks" list. */
  private notifyHostFriends(hostId: string): void {
    for (const uid of friendIds(this.db, hostId)) this.hub.send(uid, { type: 'friends.tanks' });
  }
}
