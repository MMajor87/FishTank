import { parseTiles, parseTrustedSites, parseWebglGpu, type StartTile, type WebglGpu } from './startpage.ts';

export interface TankConfig {
  /** Public origin Tanks are served from (separate from the app origin on purpose). */
  origin: string;
  image: string;
  /** Docker network Tank containers join (Caddy and the app are on it too). */
  network: string;
  /** Hostname/IP viewers use to reach the WebRTC UDP ports (Neko NAT1TO1). */
  publicHost: string;
  portRange: [number, number];
  screen: string;
  cpus: number;
  memoryGb: number;
  maxTanks: number;
  maxPerHost: number;
  idleMinutes: number;
  maxHours: number;
  /** Tiles on the Tank browser's start page and bookmarks bar. */
  startTiles: StartTile[];
  /** Domains where the Tank browser's tracking protection and uBlock Origin stand down. */
  trustedSites: string[];
  /** GPU the Tank's Firefox reports through WebGL (null = the real software renderer). */
  webglGpu: WebglGpu | null;
  /** IANA time zone for the Tank browser (null = container default, UTC). */
  timezone: string | null;
  /** How often to refresh each Tank's home-page screenshot preview (0 = no previews). */
  previewMinutes: number;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Origins allowed to make state-changing requests (CSRF guard). */
  appOrigins: string[];
  /** Base URL used in generated links (first app origin). */
  publicUrl: string;
  cookieSecure: boolean;
  /** Fastify trustProxy value: false, or a CIDR/IP list of trusted proxies (Caddy). */
  trustProxy: boolean | string;
  sessionDays: number;
  webDist: string | null;
  /** Docker Engine API endpoint, e.g. http://fishtank-docker-proxy:2375. Unset = local default socket/pipe. */
  dockerHost: string | null;
  /** Directory for nightly SQLite backups (null = disabled). */
  backupDir: string | null;
  backupKeep: number;
  tanks: TankConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trust = env.TRUST_PROXY?.trim();
  const appOrigins = (env.APP_ORIGIN ?? 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const [lo, hi] = (env.TANK_UDP_PORTS ?? '59000-59009').split('-').map(Number);
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/fishtank.sqlite',
    appOrigins,
    publicUrl: appOrigins[0] ?? 'http://localhost:3000',
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: !trust || trust === 'false' ? false : trust === 'true' ? true : trust,
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    webDist: env.WEB_DIST ?? null,
    dockerHost: env.DOCKER_HOST ?? null,
    backupDir: env.BACKUP_DIR?.trim() || null,
    backupKeep: Number(env.BACKUP_KEEP ?? 14),
    tanks: {
      origin: (env.TANK_ORIGIN ?? 'http://localhost:8081').replace(/\/$/, ''),
      image: env.TANK_IMAGE ?? 'ghcr.io/m1k1o/neko/firefox:3',
      network: env.TANK_NETWORK ?? 'fishtank-tanks',
      publicHost: env.TANK_PUBLIC_HOST ?? '127.0.0.1',
      portRange: [lo!, hi ?? lo!],
      screen: env.TANK_SCREEN ?? '1280x720@30',
      cpus: Number(env.TANK_CPUS ?? 6),
      memoryGb: Number(env.TANK_MEMORY_GB ?? 3),
      maxTanks: Number(env.MAX_TANKS ?? 4),
      maxPerHost: Number(env.TANKS_PER_HOST ?? 1),
      idleMinutes: Number(env.TANK_IDLE_MINUTES ?? 15),
      maxHours: Number(env.TANK_MAX_HOURS ?? 8),
      startTiles: parseTiles(env.TANK_START_TILES),
      trustedSites: parseTrustedSites(env.TANK_TRUSTED_SITES),
      webglGpu: parseWebglGpu(env.TANK_WEBGL_GPU),
      previewMinutes: Math.max(0, Number(env.TANK_PREVIEW_MINUTES ?? 10) || 0),
      timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(env.TANK_TIMEZONE ?? env.TZ ?? '') ? (env.TANK_TIMEZONE ?? env.TZ)! : null,
    },
  };
}
