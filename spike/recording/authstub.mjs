// Stand-in for the app's GET/POST /auth/recorder. Logs every request MediaMTX makes, and allows
// only `publish` on path "rec1" with ?key=spike-key, from the Tank range (10.88.4.128/25).
import { createServer } from 'node:http';

const KEY = 'spike-key';
const inTankRange = (ip) => /^10\.88\.4\.(1(2[89]|[3-9]\d)|2\d\d)$/.test(ip ?? '');

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const key = new URLSearchParams(p.query ?? '').get('key');
    const ok = p.action === 'publish' && p.path === 'rec1' && key === KEY && inTankRange(p.ip);
    console.log(JSON.stringify({ method: req.method, url: req.url, from: req.socket.remoteAddress, payload: p, allowed: ok }));
    res.writeHead(ok ? 200 : 401).end();
  });
}).listen(3000, () => console.log('auth stub on :3000'));
