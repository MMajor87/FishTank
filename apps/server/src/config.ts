import { parseTiles, parseTrustedSites, parseWebglGpu, type StartTile, type WebglGpu } from './startpage.ts';

/** Tank recording (docs/RECORDING.md). */
export interface RecordingConfig {
  enabled: boolean;
  /** Where the recordings volume is mounted (raw/ is written by the recorder, ready/ holds the MP4s). */
  dir: string;
  /** Days after a recording ends before it is wiped. */
  keepDays: number;
  /** Hard stop for one recording. */
  maxHours: number;
  /** Refuse to start when the recordings disk has less free space than this. */
  minFreeGb: number;
  /** Where Tanks push (the recorder's RTMP address on the Tank network). */
  rtmpUrl: string;
  /** The recorder's playback server, which cuts clips out of live recordings. */
  playbackUrl: string;
  /** Seconds in a clip ("clip the last minute"). */
  clipSeconds: number;
  /** The recorder's IP: the only caller allowed on /auth/recorder*. */
  recorderIp: string;
  /** Tank addresses (CIDR) a stream may be published from. */
  publisherCidr: string;
  /** Port of the Tank-only playback server (Tanks play shared recordings from it). */
  tankPort: number;
  /** Address the Tank-only playback server listens on. */
  tankHost: string;
  /** How a Tank's browser reaches that server (its Recordings tile and bookmark). */
  tankUrl: string;
}

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
  /** Neko broadcast pipeline for recording (null = recording off: Tanks get none). */
  broadcastPipeline: string | null;
  /** The Tank-side Recordings page, added to the start page and bookmarks (null = recording off). */
  recordingsUrl: string | null;
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
  recording: RecordingConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trust = env.TRUST_PROXY?.trim();
  const appOrigins = (env.APP_ORIGIN ?? 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const [lo, hi] = (env.TANK_UDP_PORTS ?? '59000-59009').split('-').map(Number);
  const screen = env.TANK_SCREEN ?? '1280x720@30';
  const maxHours = Number(env.TANK_MAX_HOURS ?? 8);
  const recordingEnabled = env.RECORDING_ENABLED === 'true';
  const recordingTankUrl = (env.RECORDING_TANK_URL ?? 'http://10.88.2.2:3001').replace(/\/$/, '');
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
      screen,
      cpus: Number(env.TANK_CPUS ?? 6),
      memoryGb: Number(env.TANK_MEMORY_GB ?? 3),
      maxTanks: Number(env.MAX_TANKS ?? 4),
      maxPerHost: Number(env.TANKS_PER_HOST ?? 1),
      idleMinutes: Number(env.TANK_IDLE_MINUTES ?? 15),
      maxHours,
      startTiles: parseTiles(env.TANK_START_TILES),
      trustedSites: parseTrustedSites(env.TANK_TRUSTED_SITES),
      webglGpu: parseWebglGpu(env.TANK_WEBGL_GPU),
      previewMinutes: Math.max(0, Number(env.TANK_PREVIEW_MINUTES ?? 10) || 0),
      timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(env.TANK_TIMEZONE ?? env.TZ ?? '') ? (env.TANK_TIMEZONE ?? env.TZ)! : null,
      broadcastPipeline: recordingEnabled
        ? broadcastPipeline({
            fps: screenFps(screen),
            videoKbps: clampInt(env.RECORDING_VIDEO_KBPS, 2500, 300, 20_000),
            audioKbps: clampInt(env.RECORDING_AUDIO_KBPS, 128, 32, 320),
            preset: X264_PRESETS.has(env.RECORDING_PRESET ?? '') ? env.RECORDING_PRESET! : 'veryfast',
          })
        : null,
      recordingsUrl: recordingEnabled ? `${recordingTankUrl}/` : null,
    },
    recording: {
      enabled: recordingEnabled,
      dir: env.RECORDING_DIR ?? '/recordings',
      keepDays: clampNum(env.RECORDING_KEEP_DAYS, 7, 0.01, 365),
      maxHours: clampNum(env.RECORDING_MAX_HOURS, maxHours, 0.01, 48),
      minFreeGb: clampNum(env.RECORDING_MIN_FREE_GB, 10, 0, 100_000),
      rtmpUrl: (env.RECORDER_RTMP ?? 'rtmp://10.88.2.5:1935').replace(/\/$/, ''),
      playbackUrl: (env.RECORDER_PLAYBACK ?? 'http://10.88.2.5:9996').replace(/\/$/, ''),
      clipSeconds: clampInt(env.RECORDING_CLIP_SECONDS, 60, 5, 600),
      recorderIp: env.RECORDER_ADDRESS ?? '10.88.2.5',
      publisherCidr: env.RECORDING_PUBLISHER_CIDR ?? '10.88.2.128/25',
      tankPort: clampInt(env.RECORDING_TANK_PORT, 3001, 1, 65_535),
      tankHost: env.RECORDING_TANK_HOST ?? '0.0.0.0',
      tankUrl: recordingTankUrl,
    },
  };
}

/** Refresh rate from a Neko screen spec like "1280x720@30" (30 if absent or invalid). */
export function screenFps(screen: string): number {
  const fps = Number(screen.split('@')[1]);
  return Number.isInteger(fps) && fps > 0 && fps <= 60 ? fps : 30;
}

const X264_PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']);

/**
 * Neko's broadcast pipeline, changed so browsers can play (and seek) the result: 4:2:0 High
 * profile instead of x264's automatic 4:4:4 (Firefox and Safari can't play that), the screen's
 * frame rate, and a keyframe every 2 s. Neko fills in {url}, {display} and {device}. With a
 * pipeline set, Neko ignores its own *_BITRATE / _PRESET settings. See docs/RECORDING.md.
 */
export function broadcastPipeline(o: { fps: number; videoKbps: number; audioKbps: number; preset: string }): string {
  return [
    `flvmux name=mux streamable=true ! rtmpsink location='{url} live=1'`,
    `pulsesrc device={device} ! audio/x-raw,channels=2 ! audioconvert ! queue ! voaacenc bitrate=${o.audioKbps * 1000} ! mux.`,
    `ximagesrc display-name={display} show-pointer=true use-damage=false ! video/x-raw,framerate=${o.fps}/1 ! videoconvert`,
    `! video/x-raw,format=I420 ! queue ! x264enc threads=4 bitrate=${o.videoKbps} key-int-max=${o.fps * 2} byte-stream=true`,
    `tune=zerolatency speed-preset=${o.preset} ! video/x-h264,profile=high ! mux.`,
  ].join(' ');
}

function clampNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.round(clampNum(raw, fallback, min, max));
}
