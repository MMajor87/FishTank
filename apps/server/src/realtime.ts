import type { WebSocket } from '@fastify/websocket';

export interface Connection {
  socket: WebSocket;
  userId: string;
  /** sha256 of the session token: lets logout close this session's sockets. */
  sessionId: string;
  /** Raw token, kept in memory only, to re-check the session on each heartbeat. */
  token: string;
  alive: boolean;
  /** Tank this tab is currently viewing, if any (drives idle detection and "watching" badges). */
  tankId?: string;
}

type Summary = { id: string; username: string; displayName: string };

export type RealtimeEvent =
  | { type: 'hello'; user: Summary }
  | { type: 'presence'; userId: string; online: boolean }
  | { type: 'friends.changed'; reason?: 'request' | 'accepted'; by?: Summary }
  | { type: 'tank.invite'; invite: { id: string; tank: { id: string; name: string }; by: Summary | null } }
  | { type: 'tank.updated'; tankId: string }
  | { type: 'tank.closed'; tankId: string; name: string; reason: string }
  | { type: 'tank.removed'; tankId: string; name: string }
  /** A friend's Tank opened, closed or changed: refresh the "Friends' Tanks" list. */
  | { type: 'friends.tanks' }
  /** A friend started or stopped watching a Tank: refresh their "in a Tank" status. */
  | { type: 'friends.activity'; userId: string }
  /** A Tank's recording started (by = who) or stopped. Sent to the Tank's members. */
  | { type: 'tank.recording'; tankId: string; name: string; active: boolean; by: string | null }
  /** A recording appeared, finished processing or was wiped: refresh the recordings list. */
  | { type: 'recordings.changed' }
  // Someone shared a recording to play in this Tank (sent to everyone in it, guests included).
  | { type: 'tank.playback'; tankId: string; title: string; startedAt: number; by: string }
  // Someone in the Tank saved a clip of its live recording.
  | { type: 'tank.clip'; tankId: string; by: string; seconds: number };

/** WebSocket close codes the client understands. */
export const CLOSE_SESSION_ENDED = 4001;

/**
 * Tracks live WebSocket connections per user, pushes events, and reports presence
 * transitions (first connection = online, last one gone = offline).
 */
export class Hub {
  private byUser = new Map<string, Set<Connection>>();
  private onPresence: (userId: string, online: boolean) => void;

  constructor(onPresence: (userId: string, online: boolean) => void = () => {}) {
    this.onPresence = onPresence;
  }

  /** Set during shutdown: no more presence callbacks or heartbeats (the DB may be closing). */
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  add(conn: Connection): void {
    if (this.closed) return void conn.socket.close(1001, 'Server shutting down');
    let set = this.byUser.get(conn.userId);
    if (!set) this.byUser.set(conn.userId, (set = new Set()));
    set.add(conn);
    if (set.size === 1) this.onPresence(conn.userId, true);
  }

  remove(conn: Connection): void {
    const set = this.byUser.get(conn.userId);
    if (!set?.delete(conn)) return;
    if (set.size === 0) {
      this.byUser.delete(conn.userId);
      if (!this.closed) this.onPresence(conn.userId, false);
    }
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  send(userId: string, event: RealtimeEvent): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const msg = JSON.stringify(event);
    for (const c of set) if (c.socket.readyState === c.socket.OPEN) c.socket.send(msg);
  }

  /** Ends every connection of a user (e.g. a guest whose pass was wiped). */
  closeUser(userId: string, reason = 'Session ended'): void {
    for (const c of [...(this.byUser.get(userId) ?? [])]) c.socket.close(CLOSE_SESSION_ENDED, reason);
  }

  closeSession(sessionId: string, reason = 'Session ended'): void {
    for (const c of this.all()) if (c.sessionId === sessionId) c.socket.close(CLOSE_SESSION_ENDED, reason);
  }

  /**
   * Heartbeat: drop sockets that didn't answer the last ping, and close any whose
   * session has expired, been logged out, or whose user was disabled.
   */
  sweep(isSessionValid: (conn: Connection) => boolean): void {
    if (this.closed) return;
    for (const c of this.all()) {
      if (!c.alive) {
        c.socket.terminate();
        this.remove(c);
        continue;
      }
      if (!isSessionValid(c)) {
        c.socket.close(CLOSE_SESSION_ENDED, 'Session ended');
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  closeAll(): void {
    this.closed = true;
    for (const c of this.all()) c.socket.terminate();
    this.byUser.clear();
  }

  /** Snapshot of all live connections. */
  connections(): Connection[] {
    return [...this.all()];
  }

  private *all(): Iterable<Connection> {
    for (const set of [...this.byUser.values()]) yield* [...set];
  }
}
