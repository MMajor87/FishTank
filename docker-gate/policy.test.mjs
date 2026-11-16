import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCreate, classify, forceManagedFilter, loadPolicyConfig, stripVersion } from './policy.mjs';

const cfg = loadPolicyConfig({ TANK_IMAGE: 'ghcr.io/m1k1o/neko/firefox:3', TANK_NETWORK: 'fishtank-tanks', TANK_UDP_PORTS: '59000-59009' });
const ID = 'tank-1cb2dbf1-4860-453d-aeb0-b2856883ba82';

const good = () => ({
  Image: 'ghcr.io/m1k1o/neko/firefox:3',
  Labels: { 'fishtank.managed': 'true', 'fishtank.tank': ID.slice(5) },
  Env: ['NEKO_DESKTOP_SCREEN=1280x720@30'],
  ExposedPorts: { '59003/udp': {} },
  Healthcheck: { Test: ['CMD-SHELL', 'true'] },
  HostConfig: {
    NetworkMode: 'fishtank-tanks',
    PortBindings: { '59003/udp': [{ HostPort: '59003' }] },
    ShmSize: 2 * 1024 ** 3,
    NanoCpus: 6e9,
    Memory: 3 * 1024 ** 3,
    SecurityOpt: ['no-new-privileges:true'],
    CapDrop: ['NET_RAW', 'MKNOD', 'AUDIT_WRITE'],
    PidsLimit: 2048,
    RestartPolicy: { Name: 'no' },
  },
});

test('the create body FishTank actually sends is accepted (dockerode repeats the name in the body)', () => {
  assert.equal(checkCreate(good(), cfg, ID), null);
  assert.equal(checkCreate({ ...good(), name: ID }, cfg, ID), null);
  assert.notEqual(checkCreate({ ...good(), name: 'tank-other' }, cfg, ID), null, 'mismatched name refused');
});

test('dangerous create bodies are refused', () => {
  const cases = {
    'other image': (b) => (b.Image = 'alpine'),
    privileged: (b) => (b.HostConfig.Privileged = true),
    'host bind mount': (b) => (b.HostConfig.Binds = ['/:/host']),
    'mounts': (b) => (b.HostConfig.Mounts = [{ Type: 'bind', Source: '/', Target: '/host' }]),
    'extra capability': (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN']),
    'host network': (b) => (b.HostConfig.NetworkMode = 'host'),
    'host pid': (b) => (b.HostConfig.PidMode = 'host'),
    devices: (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/kmsg' }]),
    'seccomp off': (b) => b.HostConfig.SecurityOpt.push('seccomp=unconfined'),
    'no no-new-privileges': (b) => (b.HostConfig.SecurityOpt = []),
    'tcp port': (b) => (b.HostConfig.PortBindings = { '22/tcp': [{ HostPort: '22' }] }),
    'udp port outside range': (b) => {
      b.ExposedPorts = { '53/udp': {} };
      b.HostConfig.PortBindings = { '53/udp': [{ HostPort: '53' }] };
    },
    'port remapped': (b) => (b.HostConfig.PortBindings = { '59003/udp': [{ HostPort: '59004' }] }),
    'cmd override': (b) => (b.Cmd = ['sh', '-c', 'evil']),
    'entrypoint override': (b) => (b.Entrypoint = ['sh']),
    'user override': (b) => (b.User = 'root'),
    'volumes': (b) => (b.Volumes = { '/data': {} }),
    'too many cpus': (b) => (b.HostConfig.NanoCpus = 64e9),
    'no memory limit': (b) => delete b.HostConfig.Memory,
    'missing label': (b) => (b.Labels = {}),
    'restart always': (b) => (b.HostConfig.RestartPolicy = { Name: 'always' }),
    'volumes from': (b) => (b.HostConfig.VolumesFrom = ['other-app-1']),
    'keeps NET_RAW': (b) => (b.HostConfig.CapDrop = ['MKNOD', 'AUDIT_WRITE']),
    'no pids limit': (b) => delete b.HostConfig.PidsLimit,
    'unlimited pids': (b) => (b.HostConfig.PidsLimit = -1),
    'huge pids limit': (b) => (b.HostConfig.PidsLimit = 1e6),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const b = good();
    mutate(b);
    assert.notEqual(checkCreate(b, cfg, ID), null, name);
  }
});

test('routing: only Tank lifecycle operations are allowed', () => {
  const a = (m, u) => classify(m, u, cfg).action;
  assert.equal(a('GET', '/_ping'), 'allow');
  assert.equal(a('GET', '/v1.47/containers/json?all=1'), 'allow-list');
  assert.equal(a('POST', `/containers/create?name=${ID}`), 'allow-create');
  assert.equal(a('POST', '/containers/create?name=evil'), 'deny');
  assert.equal(a('POST', `/containers/${ID}/start`), 'allow-tank');
  assert.equal(a('DELETE', `/containers/${ID}?force=true`), 'allow-tank');
  assert.equal(a('GET', `/containers/${ID}/stats?stream=false`), 'allow-tank');
  assert.equal(a('PUT', `/containers/${ID}/archive?path=%2F`), 'allow-tank');
  assert.equal(a('GET', '/images/ghcr.io/m1k1o/neko/firefox:3/json'), 'allow');
  assert.equal(a('POST', '/images/create?fromImage=ghcr.io%2Fm1k1o%2Fneko%2Ffirefox&tag=3'), 'allow');
  assert.equal(a('POST', '/images/create?fromImage=alpine&tag=latest'), 'deny');

  for (const [m, u] of [
    ['POST', `/containers/${ID}/exec`],
    ['POST', '/containers/other-app-1/exec'],
    ['POST', `/containers/${ID}/update`],
    ['POST', `/containers/${ID}/attach`],
    ['GET', `/containers/${ID}/export`],
    ['POST', '/exec/abc/start'],
    ['GET', '/info'],
    ['GET', '/volumes'],
    ['POST', '/volumes/create'],
    ['GET', '/networks'],
    ['POST', '/networks/fishtank-tanks/connect'],
    ['POST', '/build'],
    ['GET', '/images/json'],
    ['DELETE', '/images/ghcr.io/m1k1o/neko/firefox:3'],
    ['POST', '/swarm/init'],
    ['GET', '/secrets'],
  ]) assert.equal(a(m, u), 'deny', `${m} ${u}`);
});

test('container list is always forced to the managed label', () => {
  const out = new URL(forceManagedFilter('/containers/json?all=1&filters=%7B%22label%22%3A%5B%22x%3Dy%22%5D%7D'), 'http://g');
  assert.deepEqual(JSON.parse(out.searchParams.get('filters')).label, ['fishtank.managed=true']);
  assert.equal(stripVersion('/v1.51/containers/json'), '/containers/json');
});
