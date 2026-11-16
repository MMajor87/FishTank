// FishTank Docker gate — the request policy.
//
// The FishTank app may only manage its own Tank containers. Everything here is an allowlist:
// any request that doesn't match a rule is refused. A compromised app therefore can't exec into
// other containers, read other containers' config, or create privileged / host-mounting ones.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const TANK_NAME = new RegExp(`^tank-${UUID}$`);
export const MANAGED_LABEL = 'fishtank.managed';

/** Reads the gate's limits from the environment. */
export function loadPolicyConfig(env = process.env) {
  const [lo, hi] = (env.TANK_UDP_PORTS ?? '59000-59009').split('-').map(Number);
  return {
    image: env.TANK_IMAGE ?? 'ghcr.io/m1k1o/neko/firefox:3',
    network: env.TANK_NETWORK ?? 'fishtank-tanks',
    portRange: [lo, hi ?? lo],
    maxCpus: Number(env.TANK_MAX_CPUS ?? 8),
    maxMemoryGb: Number(env.TANK_MAX_MEMORY_GB ?? 6),
  };
}

/** Strips Docker's optional /v1.xx API version prefix. */
export function stripVersion(path) {
  return path.replace(/^\/v\d+(\.\d+)?(?=\/)/, '');
}

/**
 * Classifies a request. Returns one of:
 *   { action: 'deny', reason }
 *   { action: 'allow' }
 *   { action: 'allow-list' }                     – container list, label filter forced
 *   { action: 'allow-create', name }             – body must pass checkCreate()
 *   { action: 'allow-tank', id, op }             – target must be a labelled Tank container
 */
export function classify(method, rawUrl, cfg) {
  const url = new URL(rawUrl, 'http://gate');
  const path = stripVersion(url.pathname);

  if (method === 'GET' && path === '/_ping') return { action: 'allow' };
  if (method === 'HEAD' && path === '/_ping') return { action: 'allow' };

  if (method === 'GET' && path === '/containers/json') return { action: 'allow-list' };

  if (method === 'POST' && path === '/containers/create') {
    const name = url.searchParams.get('name') ?? '';
    if (!TANK_NAME.test(name)) return { action: 'deny', reason: 'container name must be tank-<uuid>' };
    return { action: 'allow-create', name };
  }

  // Tank image only: inspect and pull.
  const [repo, tag] = splitImage(cfg.image);
  if (method === 'GET' && path === `/images/${cfg.image}/json`) return { action: 'allow' };
  if (method === 'POST' && path === '/images/create') {
    const from = url.searchParams.get('fromImage') ?? '';
    const t = url.searchParams.get('tag') ?? '';
    const [fRepo, fTag] = splitImage(from);
    if (fRepo === repo && (t || fTag || 'latest') === tag) return { action: 'allow' };
    return { action: 'deny', reason: 'only the Tank image may be pulled' };
  }

  // Per-container operations, by name or id; the target is verified to be a Tank afterwards.
  const m = path.match(/^\/containers\/([^/]+)(\/[a-z]+)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2] ?? '';
    const op = `${method} ${sub || '/'}`;
    const allowed = new Set(['GET /json', 'GET /stats', 'GET /archive', 'HEAD /archive', 'PUT /archive', 'POST /start', 'POST /stop', 'POST /kill', 'POST /wait', 'DELETE /']);
    if (!allowed.has(op)) return { action: 'deny', reason: `operation not allowed: ${op}` };
    return { action: 'allow-tank', id, op };
  }

  return { action: 'deny', reason: `not allowed: ${method} ${path}` };
}

function splitImage(ref) {
  const at = ref.lastIndexOf(':');
  const slash = ref.lastIndexOf('/');
  return at > slash ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, 'latest'];
}

const empty = (v) =>
  v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

const TOP_LEVEL = new Set(['name', 'Image', 'Labels', 'Env', 'ExposedPorts', 'Healthcheck', 'HostConfig']);
const HOST_CONFIG = new Set(['NetworkMode', 'PortBindings', 'ShmSize', 'NanoCpus', 'Memory', 'SecurityOpt', 'RestartPolicy', 'CapDrop', 'PidsLimit']);
/** Capabilities every Tank must drop (NET_RAW: no ARP spoofing on the shared bridge). */
export const REQUIRED_CAP_DROP = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE'];
const MAX_PIDS = 4096;

/** Validates a container-create body. Returns null if acceptable, else the reason. */
export function checkCreate(body, cfg, expectedName) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  // Some clients (dockerode) repeat the name in the body; it must match the query name.
  if (body.name !== undefined && body.name !== expectedName) return 'name in body must match the container name';
  for (const [k, v] of Object.entries(body)) if (!TOP_LEVEL.has(k) && !empty(v)) return `field not allowed: ${k}`;
  if (body.Image !== cfg.image) return `image must be ${cfg.image}`;
  if (body.Labels?.[MANAGED_LABEL] !== 'true') return `label ${MANAGED_LABEL}=true required`;
  if (body.Env !== undefined && !(Array.isArray(body.Env) && body.Env.every((e) => typeof e === 'string'))) return 'Env must be strings';

  const hc = body.HostConfig;
  if (!hc || typeof hc !== 'object') return 'HostConfig required';
  for (const [k, v] of Object.entries(hc)) if (!HOST_CONFIG.has(k) && !empty(v)) return `HostConfig.${k} not allowed`;
  if (hc.NetworkMode !== cfg.network) return `network must be ${cfg.network}`;
  if (!(Number.isFinite(hc.NanoCpus) && hc.NanoCpus > 0 && hc.NanoCpus <= cfg.maxCpus * 1e9)) return 'NanoCpus out of range';
  if (!(Number.isFinite(hc.Memory) && hc.Memory > 0 && hc.Memory <= cfg.maxMemoryGb * 1024 ** 3)) return 'Memory out of range';
  if (hc.ShmSize !== undefined && !(hc.ShmSize > 0 && hc.ShmSize <= 4 * 1024 ** 3)) return 'ShmSize out of range';
  const sec = hc.SecurityOpt ?? [];
  if (!Array.isArray(sec) || !sec.includes('no-new-privileges:true')) return 'SecurityOpt must include no-new-privileges:true';
  if (sec.some((s) => s !== 'no-new-privileges:true')) return 'only no-new-privileges may be set in SecurityOpt';
  if (hc.RestartPolicy && !['', 'no'].includes(hc.RestartPolicy.Name ?? '')) return 'RestartPolicy must be no';
  const drop = hc.CapDrop ?? [];
  if (!Array.isArray(drop) || !drop.every((c) => typeof c === 'string')) return 'CapDrop must be a list';
  for (const cap of REQUIRED_CAP_DROP) if (!drop.includes(cap) && !drop.includes('ALL')) return `CapDrop must include ${cap}`;
  if (!(Number.isInteger(hc.PidsLimit) && hc.PidsLimit > 0 && hc.PidsLimit <= MAX_PIDS)) return `PidsLimit must be 1-${MAX_PIDS}`;

  // Ports: only UDP media ports in the Tank range, published to the same host port.
  const exposed = Object.keys(body.ExposedPorts ?? {});
  const bindings = Object.entries(hc.PortBindings ?? {});
  for (const p of [...exposed, ...bindings.map(([k]) => k)]) {
    const mm = String(p).match(/^(\d+)\/udp$/);
    if (!mm) return `port not allowed: ${p}`;
    const n = Number(mm[1]);
    if (n < cfg.portRange[0] || n > cfg.portRange[1]) return `port out of range: ${p}`;
  }
  for (const [p, list] of bindings) {
    if (!Array.isArray(list) || list.length !== 1) return `port binding for ${p} must be a single entry`;
    const b = list[0] ?? {};
    if (String(b.HostPort) !== p.split('/')[0]) return `host port must equal container port for ${p}`;
    if (b.HostIp && b.HostIp !== '0.0.0.0') return `host IP not allowed for ${p}`;
  }
  return null;
}

/** Forces the container list to Tank containers only. */
export function forceManagedFilter(rawUrl) {
  const url = new URL(rawUrl, 'http://gate');
  let filters = {};
  try {
    filters = JSON.parse(url.searchParams.get('filters') ?? '{}') ?? {};
  } catch {
    filters = {};
  }
  filters.label = [`${MANAGED_LABEL}=true`];
  url.searchParams.set('filters', JSON.stringify(filters));
  return url.pathname + url.search;
}
