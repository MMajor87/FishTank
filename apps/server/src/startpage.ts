/**
 * The page each Tank's Firefox opens on: big tiles for the services you watch together.
 * It is written into the container as a local file, so the LAN addresses in it are never
 * served publicly.
 */

export interface StartTile {
  title: string;
  url: string;
}

export const START_PAGE_PATH = '/opt/fishtank/start.html';
export const START_PAGE_URL = `file://${START_PAGE_PATH}`;
const UBLOCK_ID = 'uBlock0@raymondhill.net';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PALETTE = ['#ff8a3d', '#4fd1a5', '#7aa2ff', '#f06595', '#ffd43b', '#9775fa'];

export function parseTiles(raw: string | undefined): StartTile[] {
  const fallback = [{ title: 'YouTube', url: 'https://www.youtube.com/' }];
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const tiles = parsed.filter(
      (t): t is StartTile => typeof t?.title === 'string' && typeof t?.url === 'string' && /^https?:\/\//.test(t.url),
    );
    return tiles.length ? tiles.slice(0, 12) : fallback;
  } catch {
    return fallback;
  }
}

export function startPageHtml(tankName: string, tiles: StartTile[]): string {
  const cards = tiles
    .map(
      (t, i) => `<a class="tile" href="${esc(t.url)}" style="--c:${PALETTE[i % PALETTE.length]}">
  <span class="icon">${esc(t.title.trim().charAt(0).toUpperCase() || '?')}</span>
  <span class="title">${esc(t.title)}</span>
</a>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(tankName)} · FishTank</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 28px; padding: 32px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e3f2f7;
    background: radial-gradient(ellipse at top, #123444, #071a24 55%, #04121a);
  }
  header { text-align: center; }
  h1 { margin: 0; font-size: 2.2rem; }
  p { margin: 6px 0 0; color: #8fb3c1; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 220px)); gap: 18px; justify-content: center; }
  .tile {
    display: grid; justify-items: center; gap: 10px; padding: 26px 16px; text-decoration: none; color: inherit;
    background: #0d2836; border: 1px solid #1f4a5e; border-radius: 16px; transition: transform .12s, border-color .12s;
  }
  .tile:hover, .tile:focus-visible { transform: translateY(-3px); border-color: var(--c); outline: none; }
  .icon {
    width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center;
    font-size: 2rem; font-weight: 700; color: #071a24; background: var(--c);
  }
  .title { font-size: 1.25rem; font-weight: 600; }
  footer { text-align: center; font-size: .85rem; color: #8fb3c1; max-width: 640px; }
</style>
</head>
<body>
<header>
  <h1>🐟 ${esc(tankName)}</h1>
  <p>Pick something to watch together.</p>
</header>
<nav class="tiles">
${cards}
</nav>
<footer>Anything you log into here is visible to everyone in the room, and wiped when the Tank is drained.</footer>
</body>
</html>
`;
}

/**
 * Sites (bare domains, e.g. "twitch.tv") where the Tank browser's blockers stand down.
 * Twitch's login runs an anti-bot integrity check that Firefox's fingerprinting protection
 * and uBlock Origin can block; Twitch then rejects the login as an "unsupported browser".
 */
export function parseTrustedSites(raw: string | undefined): string[] {
  if (raw === undefined) return ['twitch.tv'];
  const domain = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^\*\./, ''))
        .filter((d) => domain.test(d)),
    ),
  ];
}

export interface WebglGpu {
  vendor: string;
  renderer: string;
}

/**
 * TANK_WEBGL_GPU="vendor|renderer". Tanks have no GPU, so WebGL reports a software renderer
 * ("llvmpipe"), a classic bot signal for login checks like Twitch's. Empty disables.
 */
export function parseWebglGpu(raw: string | undefined): WebglGpu | null {
  const [vendor, renderer] = (raw ?? 'NVIDIA Corporation|NVIDIA GeForce RTX 3070/PCIe/SSE2').split('|').map((s) => s?.trim());
  return vendor && renderer ? { vendor, renderer } : null;
}

/** Profile prefs (user.js) for the Tank's Firefox. */
export function firefoxUserJs(gpu: WebglGpu): string {
  return [
    `user_pref("webgl.override-unmasked-vendor", ${JSON.stringify(gpu.vendor)});`,
    `user_pref("webgl.override-unmasked-renderer", ${JSON.stringify(gpu.renderer)});`,
    '',
  ].join('\n');
}

/** Adds FishTank's homepage, bookmark tiles and trusted-site exceptions to the image's own Firefox policies. */
export function withFishTankPolicies(base: unknown, tiles: StartTile[], trustedSites: string[] = []): object {
  const doc = (base && typeof base === 'object' ? base : {}) as { policies?: Record<string, unknown> };
  const policies = { ...(doc.policies ?? {}) };
  policies.Homepage = { URL: START_PAGE_URL, Locked: false, StartPage: 'homepage' };
  policies.Bookmarks = [
    { Title: 'Start', URL: START_PAGE_URL, Placement: 'toolbar' },
    ...tiles.map((t) => ({ Title: t.title, URL: t.url, Placement: 'toolbar' })),
  ];
  policies.DisplayBookmarksToolbar = true;
  if (trustedSites.length) {
    // Firefox tracking/fingerprinting protection off for these sites (exceptions are per origin).
    const etp = (policies.EnableTrackingProtection ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(etp.Exceptions) ? (etp.Exceptions as string[]) : [];
    const origins = trustedSites.flatMap((d) => [`https://${d}`, `https://www.${d}`]);
    policies.EnableTrackingProtection = { ...etp, Exceptions: [...new Set([...existing, ...origins])] };
    // uBlock Origin: treat them as trusted sites (no filtering there), via its managed storage.
    const third = (policies['3rdparty'] ?? {}) as { Extensions?: Record<string, Record<string, unknown>> };
    const exts = { ...(third.Extensions ?? {}) };
    const ubo = { ...(exts[UBLOCK_ID] ?? {}) };
    const toAdd = { ...((ubo.toAdd ?? {}) as Record<string, unknown>) };
    const sites = Array.isArray(toAdd.trustedSiteDirectives) ? (toAdd.trustedSiteDirectives as string[]) : [];
    toAdd.trustedSiteDirectives = [...new Set([...sites, ...trustedSites])];
    exts[UBLOCK_ID] = { ...ubo, toAdd };
    policies['3rdparty'] = { ...third, Extensions: exts };
  }
  return { ...doc, policies };
}
