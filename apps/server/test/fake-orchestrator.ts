import { BroadcastError, type ManagedContainer, type NekoMember, type Orchestrator, type TankCredentials, type TankSpec } from '../src/orchestrator.ts';

/** In-memory stand-in for Docker + Neko. */
export class FakeOrchestrator implements Orchestrator {
  /** `legacy` simulates a Tank started by an older version (shared Neko passwords). */
  containers = new Map<string, { spec: TankSpec; running: boolean; legacy?: TankCredentials }>();
  /** tankId → Neko username → login. */
  members = new Map<string, Map<string, NekoMember>>();
  removed: Array<{ tankId: string; username: string }> = [];
  async ensureMember(tankId: string, _token: string, m: NekoMember) {
    if (!this.members.has(tankId)) this.members.set(tankId, new Map());
    this.members.get(tankId)!.set(m.username, m);
  }
  /** Server-side Neko sign-ins: the password must match the member's. Legacy Tanks have no cookie sessions. */
  logins: Array<{ tankId: string; username: string }> = [];
  async login(tankId: string, username: string, password: string) {
    const c = this.containers.get(tankId);
    if (c?.legacy) return null;
    const m = this.members.get(tankId)?.get(username);
    if (!m || m.password !== password) throw new Error('neko login failed: 401');
    this.logins.push({ tankId, username });
    return `session-${username}`;
  }
  updates: NekoMember[] = [];
  async updateMember(tankId: string, _token: string, m: NekoMember) {
    this.updates.push(m);
    this.members.get(tankId)?.set(m.username, { ...m, password: this.members.get(tankId)?.get(m.username)?.password ?? '' });
  }
  async removeMember(tankId: string, _token: string, username: string) {
    this.removed.push({ tankId, username });
    this.members.get(tankId)?.delete(username);
  }
  /** Whether Tanks are started with the broadcast pipeline (as credentials() reads back). */
  recordable = false;
  destroyed: string[] = [];
  failNextStart = false;
  async ensureImage() {}
  async pullImage() {}
  async start(spec: TankSpec) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error('boom');
    }
    this.containers.set(spec.id, { spec, running: true });
    return `container-${spec.id}`;
  }
  async waitReady() {}
  async destroy(id: string) {
    this.destroyed.push(id);
    this.containers.delete(id);
  }
  async list(): Promise<ManagedContainer[]> {
    return [...this.containers.entries()].map(([tankId, c]) => ({ tankId, containerId: `container-${tankId}`, running: c.running }));
  }
  async credentials(id: string): Promise<TankCredentials | null> {
    const c = this.containers.get(id);
    return c ? (c.legacy ?? { apiToken: c.spec.apiToken, recordable: this.recordable }) : null;
  }
  shots = 0;
  async screenshot() {
    this.shots++;
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  }
  disconnects: Array<{ tankId: string; username: string; apiToken: string }> = [];
  async stats() {
    return { cpuPercent: 42, memoryMb: 512 };
  }
  async disconnectUser(tankId: string, username: string, apiToken: string) {
    this.disconnects.push({ tankId, username, apiToken });
    return 1;
  }
  /** tankId → URL Neko is pushing to (Neko's own view: it stays set even if the recorder refused). */
  broadcasts = new Map<string, string>();
  broadcastLog: Array<{ op: 'start' | 'stop'; tankId: string; url?: string }> = [];
  /** Simulates the recorder: called after Neko starts pushing (tests send its events from here). */
  onBroadcastStart: ((tankId: string, url: string) => void) | null = null;
  failNextBroadcast: number | null = null;
  async startBroadcast(tankId: string, _token: string, url: string) {
    this.broadcastLog.push({ op: 'start', tankId, url });
    if (this.failNextBroadcast) {
      const status = this.failNextBroadcast;
      this.failNextBroadcast = null;
      throw new BroadcastError(`neko broadcast start failed: ${status}`, status);
    }
    if (this.broadcasts.has(tankId)) throw new BroadcastError('neko broadcast start failed: 422', 422);
    this.broadcasts.set(tankId, url);
    this.onBroadcastStart?.(tankId, url);
  }
  /** tankId → container IP on the Tank network (tests set these). */
  addresses = new Map<string, string>();
  async address(tankId: string) {
    return this.containers.has(tankId) ? (this.addresses.get(tankId) ?? null) : null;
  }
  async stopBroadcast(tankId: string) {
    this.broadcastLog.push({ op: 'stop', tankId });
    this.broadcasts.delete(tankId);
  }
}

