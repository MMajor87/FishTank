// FishTank Docker gate — a tiny allowlisting proxy in front of the Docker socket.
// Only the FishTank app can reach it (internal network). See policy.mjs for the rules.
import http from 'node:http';
import { MANAGED_LABEL, TANK_NAME, checkCreate, classify, forceManagedFilter, loadPolicyConfig } from './policy.mjs';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const PORT = Number(process.env.PORT ?? 2375);
const MAX_CREATE_BODY = 256 * 1024;
const MAX_ARCHIVE_BODY = 8 * 1024 * 1024;
const cfg = loadPolicyConfig();

const log = (msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

/** Plain request to the Docker socket, buffered (for our own checks). */
function dockerJson(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Streams a request through to Docker (optionally with a replacement path/body). */
function forward(req, res, { path = req.url, body } = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  if (body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(body));
    delete headers['transfer-encoding'];
  }
  const up = http.request({ socketPath: SOCKET, method: req.method, path, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (err) => {
    log('upstream error', { err: err.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'docker unavailable' }));
  });
  if (body !== undefined) up.end(body);
  else req.pipe(up);
}

function deny(res, req, reason, status = 403) {
  // Path only: query strings can carry container env (e.g. Neko passwords) from some clients.
  log('denied', { method: req.method, path: new URL(req.url, 'http://gate').pathname, reason });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: `fishtank-gate: ${reason}` }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const rule = classify(req.method, req.url, cfg);
    switch (rule.action) {
      case 'deny':
        return deny(res, req, rule.reason);
      case 'allow':
        return forward(req, res);
      case 'allow-list':
        return forward(req, res, { path: forceManagedFilter(req.url) });
      case 'allow-create': {
        const raw = await readBody(req, MAX_CREATE_BODY);
        let body;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return deny(res, req, 'invalid JSON', 400);
        }
        const problem = checkCreate(body, cfg, rule.name);
        if (problem) return deny(res, req, problem);
        log('create', { name: rule.name });
        // Forward a clean URL: Docker only needs the name; drop anything else in the query.
        return forward(req, res, { path: `/containers/create?name=${encodeURIComponent(rule.name)}`, body: JSON.stringify(body) });
      }
      case 'allow-tank': {
        // Confirm the target really is a FishTank-managed Tank container.
        const info = await dockerJson('GET', `/containers/${encodeURIComponent(rule.id)}/json`);
        if (info.status === 404) return deny(res, req, 'no such container', 404);
        const name = String(info.body?.Name ?? '').replace(/^\//, '');
        if (info.status !== 200 || info.body?.Config?.Labels?.[MANAGED_LABEL] !== 'true' || !TANK_NAME.test(name)) {
          return deny(res, req, 'not a Tank container');
        }
        if (rule.op === 'PUT /archive') {
          const tar = await readBody(req, MAX_ARCHIVE_BODY);
          return forward(req, res, { body: tar });
        }
        if (rule.op === 'DELETE /') log('remove', { name });
        return forward(req, res);
      }
    }
  } catch (err) {
    log('gate error', { err: err.message });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'fishtank-gate error' }));
  }
});

server.listen(PORT, () => log('fishtank docker gate listening', { port: PORT, image: cfg.image, network: cfg.network, ports: cfg.portRange }));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
