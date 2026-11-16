import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarFiles, untarFirstFile } from '../src/tar.ts';
import { START_PAGE_URL, firefoxUserJs, parseTiles, parseTrustedSites, parseWebglGpu, startPageHtml, withFishTankPolicies } from '../src/startpage.ts';

test('tar: writes entries Docker can read and reads back the first file', () => {
  const data = Buffer.from('{"hello":"world"}');
  const tar = tarFiles([{ name: 'opt/fishtank', dir: true }, { name: 'opt/fishtank/a.json', data }]);
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.subarray(257, 262).toString(), 'ustar');
  assert.deepEqual(untarFirstFile(tar), data, 'skips the directory entry');
  // Header checksum is valid (sum of header bytes with the checksum field as spaces).
  const h = Buffer.from(tar.subarray(0, 512));
  const stored = parseInt(h.subarray(148, 154).toString(), 8);
  h.fill(0x20, 148, 156);
  assert.equal(stored, h.reduce((a, b) => a + b, 0));
});

test('policies: keeps the image settings, adds homepage and bookmark tiles', () => {
  const base = { policies: { DisableTelemetry: true, Bookmarks: [{ Title: 'IPLeak' }], Homepage: { StartPage: 'home' } } };
  const tiles = [{ title: 'Jellyfin', url: 'http://192.168.1.50:8096/' }];
  const out = withFishTankPolicies(base, tiles) as { policies: Record<string, any> };
  assert.equal(out.policies.DisableTelemetry, true);
  assert.deepEqual(out.policies.Homepage, { URL: START_PAGE_URL, Locked: false, StartPage: 'homepage' });
  assert.deepEqual(
    out.policies.Bookmarks.map((b: any) => b.Title),
    ['Start', 'Jellyfin'],
  );
  assert.equal(out.policies.DisplayBookmarksToolbar, true);
});

test('start page escapes names/urls; tile config is validated', () => {
  const html = startPageHtml('<script>alert(1)</script>', [{ title: 'A"b', url: 'https://x.test/?a=1&b=2' }]);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('href="https://x.test/?a=1&amp;b=2"'));

  assert.deepEqual(parseTiles(undefined).map((t) => t.title), ['YouTube']);
  assert.deepEqual(parseTiles('not json').map((t) => t.title), ['YouTube']);
  assert.deepEqual(
    parseTiles('[{"title":"ok","url":"https://ok.test"},{"title":"bad","url":"javascript:alert(1)"}]').map((t) => t.title),
    ['ok'],
    'non-http(s) URLs dropped',
  );
});

test('trusted sites: tracking-protection exceptions + uBlock trusted sites, image settings kept', () => {
  const base = {
    policies: {
      EnableTrackingProtection: { Value: true, Fingerprinting: true, Cryptomining: true },
      ExtensionSettings: { 'uBlock0@raymondhill.net': { installation_mode: 'force_installed' } },
    },
  };
  const out = withFishTankPolicies(base, [], ['twitch.tv']) as { policies: Record<string, any> };
  assert.deepEqual(out.policies.EnableTrackingProtection, {
    Value: true,
    Fingerprinting: true,
    Cryptomining: true,
    Exceptions: ['https://twitch.tv', 'https://www.twitch.tv'],
  });
  assert.deepEqual(out.policies['3rdparty'].Extensions['uBlock0@raymondhill.net'], { toAdd: { trustedSiteDirectives: ['twitch.tv'] } });
  assert.deepEqual(out.policies.ExtensionSettings, base.policies.ExtensionSettings);

  const none = withFishTankPolicies(base, [], []) as { policies: Record<string, any> };
  assert.equal(none.policies['3rdparty'], undefined);
  assert.equal(none.policies.EnableTrackingProtection.Exceptions, undefined);
});

test('trusted sites config: default twitch.tv, empty disables, junk dropped', () => {
  assert.deepEqual(parseTrustedSites(undefined), ['twitch.tv']);
  assert.deepEqual(parseTrustedSites(''), []);
  assert.deepEqual(parseTrustedSites('Twitch.tv, *.kick.com  twitch.tv https://evil/ "x"'), ['twitch.tv', 'kick.com']);
});

test('webgl gpu: default, custom, disabled; user.js quotes values', () => {
  assert.deepEqual(parseWebglGpu(undefined), { vendor: 'NVIDIA Corporation', renderer: 'NVIDIA GeForce RTX 3070/PCIe/SSE2' });
  assert.deepEqual(parseWebglGpu(' Intel | Mesa Intel(R) UHD 630 '), { vendor: 'Intel', renderer: 'Mesa Intel(R) UHD 630' });
  assert.equal(parseWebglGpu(''), null);
  assert.equal(parseWebglGpu('only-vendor'), null);
  const js = firefoxUserJs({ vendor: 'A"b', renderer: 'R' });
  assert.ok(js.includes('user_pref("webgl.override-unmasked-vendor", "A\\"b");'));
  assert.ok(js.includes('user_pref("webgl.override-unmasked-renderer", "R");'));
});
