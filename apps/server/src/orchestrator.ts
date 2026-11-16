import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import Docker from 'dockerode';
import type { TankConfig } from './config.ts';
import { START_PAGE_PATH, firefoxUserJs, startPageHtml, withFishTankPolicies } from './startpage.ts';
import { tarFiles, untarFirstFile } from './tar.ts';

/**
 * How the app talks to a Tank's Neko. Current Tanks have only an API token: each person gets
 * their own Neko login (created through the API, with per-person permissions). Tanks started
 * by older versions use two shared passwords (Neko "multiuser") until they're drained.
 */
export interface TankCredentials {
  apiToken?: string;
  /** Legacy shared passwords. */
  userPassword?: string;
  adminPassword?: string;
}

/** A person's Neko login inside one Tank. */
export interface NekoMember {
  username: string;
  password: string;
  displayName: string;
  /** Absolute image URL shown in Neko's member list (null = Neko's generated avatar). */
  avatarUrl: string | null;
  /** host = Neko admin; member = may be handed control; guest = watch only. */
  kind: 'host' | 'member' | 'guest';
}

export interface TankSpec {
  apiToken: string;
  id: string;
  udpPort: number;
  /** Shown on the Tank browser's start page. */
  name: string;
}

export interface TankStats {
  /** Percent of one CPU core (e.g. 250 = 2.5 cores). */
  cpuPercent: number;
  memoryMb: number;
}

export interface ManagedContainer {
  tankId: string;
  containerId: string;
  running: boolean;
}

/** Everything FishTank needs from Docker. Swapped for a fake in tests. */
export interface Orchestrator {
  ensureImage(): Promise<void>;
  /** Pulls the latest Tank image (security updates for the browser). New Tanks use it. */
  pullImage(): Promise<void>;
  /** Creates and starts the Tank container; resolves with its container id. */
  start(spec: TankSpec): Promise<string>;
  /** Resolves once Neko answers HTTP, rejects after the timeout. */
  waitReady(tankId: string, timeoutMs: number): Promise<void>;
  /** Force-removes the container (no-op if it's already gone). */
  destroy(tankId: string): Promise<void>;
  list(): Promise<ManagedContainer[]>;
  /** Reads Neko passwords back from a running container, so Tanks survive app restarts. */
  credentials(tankId: string): Promise<TankCredentials | null>;
  /** Disconnects and removes a user's Neko sessions. Returns how many were removed. (Legacy Tanks.) */
  disconnectUser(tankId: string, username: string, apiToken: string): Promise<number>;
  /**
   * Logs a person in to Neko from the server and returns the session token (Neko's session
   * cookie value), so the browser never needs the password. Null if the Tank doesn't use
   * cookie sessions (started by an older version).
   */
  login(tankId: string, username: string, password: string): Promise<string | null>;
  /** Creates a person's Neko login (no-op if it already exists). */
  ensureMember(tankId: string, apiToken: string, member: NekoMember): Promise<void>;
  /** Updates a person's Neko profile (name, avatar, permissions) in place. */
  updateMember(tankId: string, apiToken: string, member: NekoMember): Promise<void>;
  /** Deletes a person's Neko login, which also ends their Neko session. */
  removeMember(tankId: string, apiToken: string, username: string): Promise<void>;
  /** One-shot resource usage for the admin dashboard (null if unavailable). */
  stats(tankId: string): Promise<TankStats | null>;
  /** A JPEG of the Tank's screen, via Neko's API (null if unavailable). */
  screenshot(tankId: string, apiToken: string): Promise<Buffer | null>;
}

export const containerName = (tankId: string) => `tank-${tankId}`;
/** Neko's session cookie name (its default). The app sets it per Tank path on the Tank origin. */
export const NEKO_SESSION_COOKIE = 'NEKO_SESSION';
/** Neko serves under /<tankId> so one Tank origin can route to many containers by path. */
export const tankPathPrefix = (tankId: string) => `/${tankId}`;

const LABEL_MANAGED = 'fishtank.managed';
const LABEL_TANK = 'fishtank.tank';
const USER_PW = 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD';
const ADMIN_PW = 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD';
const API_TOKEN = 'NEKO_SESSION_API_TOKEN';
const NEKO_MEMBERS_FILE = '/tmp/neko-members.json';
const TANK_CAP_DROP = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE'];
const FIREFOX_POLICIES = '/usr/lib/firefox/distribution/policies.json';
const NEKO_PROFILE = 'home/neko/.mozilla/firefox/profile.default';
const NEKO_UID = 1000;

export class DockerOrchestrator implements Orchestrator {
  private docker: Docker;
  private cfg: TankConfig;
  private warn: (obj: object, msg: string) => void;

  constructor(cfg: TankConfig, dockerHost: string | null, warn: (obj: object, msg: string) => void = () => {}) {
    this.cfg = cfg;
    this.warn = warn;
    if (dockerHost) {
      const url = new URL(dockerHost);
      this.docker = new Docker({ protocol: url.protocol.replace(':', '') as 'http' | 'https', host: url.hostname, port: Number(url.port || 2375) });
    } else {
      this.docker = new Docker();
    }
  }

  async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(this.cfg.image).inspect();
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      await this.pullImage();
    }
  }

  async pullImage(): Promise<void> {
    const stream = await this.docker.pull(this.cfg.image);
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())),
    );
  }

  async start(spec: TankSpec): Promise<string> {
    const c = this.cfg;
    const udp = `${spec.udpPort}/udp`;
    const publicIp = await resolvePublicIp(c.publicHost);
    const container = await this.docker.createContainer({
      name: containerName(spec.id),
      Image: c.image,
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_TANK]: spec.id },
      Env: [
        `NEKO_DESKTOP_SCREEN=${c.screen}`,
        // Capture at the screen's refresh rate. Neko's default is 25 fps, which against a
        // 30 Hz screen repeats/drops a frame several times a second (visible jitter).
        `NEKO_MAX_FPS=${screenFps(c.screen)}`,
        // One Neko login per person, created by the app through the API (see ensureMember),
        // kept in a file inside the container that dies with it.
        'NEKO_MEMBER_PROVIDER=file',
        `NEKO_MEMBER_FILE_PATH=${NEKO_MEMBERS_FILE}`,
        'NEKO_MEMBER_FILE_HASH=true',
        // Session in a cookie (set by the app per Tank path), so passwords never go in URLs.
        'NEKO_SESSION_COOKIE_ENABLED=true',
        `${API_TOKEN}=${spec.apiToken}`,
        `NEKO_WEBRTC_UDPMUX=${spec.udpPort}`,
        'NEKO_WEBRTC_ICELITE=1',
        `NEKO_WEBRTC_NAT1TO1=${publicIp}`,
        `NEKO_SERVER_PATH_PREFIX=${tankPathPrefix(spec.id)}`,
        'NEKO_SERVER_PROXY=true',
        // Viewers use external voice apps: no mic/webcam upstream into the Tank.
        'NEKO_CAPTURE_MICROPHONE_ENABLED=false',
        'NEKO_CAPTURE_WEBCAM_ENABLED=false',
        // Guests can't take control until the host hands it over or unlocks it.
        'NEKO_SESSION_LOCKED_CONTROLS=true',
        // No dragging files from viewers' computers into the Tank browser.
        'NEKO_DESKTOP_UPLOAD_DROP=false',
        // Browser clock matches the home IP's region (UTC next to a US IP looks like a bot).
        ...(c.timezone ? [`TZ=${c.timezone}`] : []),
      ],
      ExposedPorts: { [udp]: {} },
      // The image's own healthcheck calls /health, but with a path prefix it lives under it.
      Healthcheck: {
        Test: ['CMD-SHELL', `wget -q -O /dev/null http://localhost:8080${tankPathPrefix(spec.id)}/health || exit 1`],
        Interval: 10e9,
        Timeout: 5e9,
        Retries: 8,
      },
      HostConfig: {
        NetworkMode: c.network,
        PortBindings: { [udp]: [{ HostPort: String(spec.udpPort) }] },
        ShmSize: 2 * 1024 ** 3,
        NanoCpus: Math.round(c.cpus * 1e9),
        Memory: Math.round(c.memoryGb * 1024 ** 3),
        SecurityOpt: ['no-new-privileges:true'],
        // Capabilities a Tank never needs. NET_RAW matters most: Tanks share a bridge with the
        // app and Caddy, and raw sockets would allow ARP spoofing there (iptables can't stop it).
        CapDrop: TANK_CAP_DROP,
        // Fork-bomb guard. An idle Tank uses ~300 threads; heavy browsing stays well under this.
        PidsLimit: 2048,
        RestartPolicy: { Name: 'no' },
        // No volumes: the browser profile lives in the container and dies with it.
      },
    });
    try {
      await this.installStartPage(container, spec.name);
    } catch (err) {
      // Nice-to-have: the Tank still works with Firefox's default homepage.
      this.warn({ err, tankId: spec.id }, 'could not install tank start page');
    }
    await container.start();
    return container.id;
  }

  /** Before Firefox first starts: add our homepage + bookmark tiles to the image's policies. */
  private async installStartPage(container: Docker.Container, tankName: string): Promise<void> {
    const archive = await container.getArchive({ path: FIREFOX_POLICIES });
    const chunks: Buffer[] = [];
    for await (const chunk of archive as AsyncIterable<Buffer>) chunks.push(chunk);
    const current = untarFirstFile(Buffer.concat(chunks));
    const base = current ? JSON.parse(current.toString('utf8')) : {};
    const policies = Buffer.from(JSON.stringify(withFishTankPolicies(base, this.cfg.startTiles, this.cfg.trustedSites), null, 2));
    const page = Buffer.from(startPageHtml(tankName, this.cfg.startTiles));

    await container.putArchive(
      tarFiles([
        { name: FIREFOX_POLICIES.slice(1), data: policies },
        { name: 'opt/fishtank', dir: true },
        { name: START_PAGE_PATH.slice(1), data: page },
        // SponsorBlock opens a welcome tab on first install unless its storage says it was
        // already installed. Firefox imports this legacy storage file on the extension's first run.
        ...(this.cfg.webglGpu
          ? [{ name: NEKO_PROFILE + '/user.js', data: Buffer.from(firefoxUserJs(this.cfg.webglGpu)), uid: NEKO_UID, gid: NEKO_UID }]
          : []),
        { name: NEKO_PROFILE + '/browser-extension-data', dir: true, uid: NEKO_UID, gid: NEKO_UID },
        { name: NEKO_PROFILE + '/browser-extension-data/sponsorBlocker@ajay.app', dir: true, uid: NEKO_UID, gid: NEKO_UID },
        {
          name: NEKO_PROFILE + '/browser-extension-data/sponsorBlocker@ajay.app/storage.js',
          data: Buffer.from(JSON.stringify({ alreadyInstalled: true })),
          uid: NEKO_UID,
          gid: NEKO_UID,
        },
      ]),
      { path: '/' },
    );
  }

  async stats(tankId: string): Promise<TankStats | null> {
    try {
      const s = (await this.docker.getContainer(containerName(tankId)).stats({ stream: false })) as unknown as {
        cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
        precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
        memory_stats: { usage?: number; stats?: { inactive_file?: number; cache?: number } };
      };
      const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
      const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
      const cpus = s.cpu_stats.online_cpus ?? 1;
      const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
      const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
      const memoryMb = Math.max(0, (s.memory_stats.usage ?? 0) - cache) / 1024 / 1024;
      return { cpuPercent: Math.round(cpuPercent), memoryMb: Math.round(memoryMb) };
    } catch {
      return null;
    }
  }

  async waitReady(tankId: string, timeoutMs: number): Promise<void> {
    const url = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/health`;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error(`Tank ${tankId} did not become ready within ${timeoutMs}ms`);
  }

  async destroy(tankId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(tankId)).remove({ force: true });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }

  async list(): Promise<ManagedContainer[]> {
    const rows = await this.docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }) });
    return rows
      .filter((r) => r.Labels?.[LABEL_TANK])
      .map((r) => ({ tankId: r.Labels[LABEL_TANK]!, containerId: r.Id, running: r.State === 'running' }));
  }

  async screenshot(tankId: string, apiToken: string): Promise<Buffer | null> {
    const url = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/room/screen/shot.jpg?quality=45`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/jpeg')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length <= 2_000_000 ? buf : null;
  }

  async disconnectUser(tankId: string, username: string, apiToken: string): Promise<number> {
    const base = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/sessions`;
    const auth = { authorization: `Bearer ${apiToken}` };
    const res = await fetch(base, { headers: auth, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`neko sessions list failed: ${res.status}`);
    const sessions = (await res.json()) as NekoSession[];
    let removed = 0;
    for (const s of sessions.filter((s) => s.profile?.name === username)) {
      const id = encodeURIComponent(s.id);
      await fetch(`${base}/${id}/disconnect`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(5000) });
      const del = await fetch(`${base}/${id}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(5000) });
      if (del.ok) removed++;
    }
    return removed;
  }

  async login(tankId: string, username: string, password: string): Promise<string | null> {
    const url = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/login`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`neko login failed: ${res.status}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${NEKO_SESSION_COOKIE}=`));
    const token = cookie?.slice(NEKO_SESSION_COOKIE.length + 1).split(';')[0];
    return token || null;
  }

  async ensureMember(tankId: string, apiToken: string, m: NekoMember): Promise<void> {
    const base = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/members`;
    const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };
    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: m.username, password: m.password, profile: nekoProfile(m) }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return;
    // Already there (e.g. the app restarted): its password is derived the same way, so just
    // bring the profile (name, avatar, permissions) up to date.
    const existing = await fetch(`${base}/${encodeURIComponent(m.username)}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!existing.ok) throw new Error(`neko member create failed: ${res.status}`);
    await this.updateMember(tankId, apiToken, m);
  }

  async updateMember(tankId: string, apiToken: string, m: NekoMember): Promise<void> {
    const url = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/members/${encodeURIComponent(m.username)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(nekoProfile(m)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`neko member update failed: ${res.status}`);
  }

  async removeMember(tankId: string, apiToken: string, username: string): Promise<void> {
    const url = `http://${containerName(tankId)}:8080${tankPathPrefix(tankId)}/api/members/${encodeURIComponent(username)}`;
    const res = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok && res.status !== 404) throw new Error(`neko member delete failed: ${res.status}`);
  }

  async credentials(tankId: string): Promise<TankCredentials | null> {
    try {
      const info = await this.docker.getContainer(containerName(tankId)).inspect();
      const env = new Map((info.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
      const userPassword = env.get(USER_PW);
      const adminPassword = env.get(ADMIN_PW);
      const apiToken = env.get(API_TOKEN);
      if (userPassword && adminPassword) return { userPassword, adminPassword, apiToken }; // legacy Tank
      return apiToken ? { apiToken } : null;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }
}

/** Refresh rate from a Neko screen spec like "1280x720@30" (30 if absent or invalid). */
export function screenFps(screen: string): number {
  const fps = Number(screen.split('@')[1]);
  return Number.isInteger(fps) && fps > 0 && fps <= 60 ? fps : 30;
}

/**
 * Neko's WebRTC stack rejects hostnames in NAT1TO1 ("invalid address rewrite mapping"),
 * so resolve the public host to an IPv4 address when each Tank starts. New Tanks pick up
 * Dynamic DNS changes automatically.
 */
export async function resolvePublicIp(host: string): Promise<string> {
  if (isIP(host)) return host;
  const { address } = await lookup(host, { family: 4 });
  return address;
}

/** Neko permissions per kind of person. Only the host is a Neko admin; guests can never take control. */
export function nekoProfile(m: NekoMember) {
  return {
    name: m.displayName,
    avatar: m.avatarUrl ?? '',
    is_admin: m.kind === 'host',
    can_login: true,
    can_connect: true,
    can_watch: true,
    can_host: m.kind !== 'guest',
    can_share_media: false,
    can_access_clipboard: m.kind !== 'guest',
    sends_inactive_cursor: true,
    can_see_inactive_cursors: false,
  };
}

export interface NekoSession {
  id: string;
  profile?: { name?: string };
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number })?.statusCode;
}
