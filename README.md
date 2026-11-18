# 🐟 FishTank

A self-hosted watch-party service for small groups of friends. Each **Tank** is a throwaway
web browser running in its own Docker container and streamed to everyone in the room over
WebRTC (via [Neko](https://github.com/m1k1o/neko)). Load YouTube, Twitch, Jellyfin, Plex or
any other non-DRM site in it and watch together in sync. When the Tank closes, the
container is deleted with everything in it: cookies, logins and history.

- **Invite-only.** Permanent accounts need a `FISH-` sign-up code from an existing member.
  Rooms are never listed publicly.
- **Two ways in.** Invite friends directly, with a live notification, or share a `TANK-` link.
  People without an account join from the link as temporary, watch-only guests.
- **Friends.** Friend requests, blocking, online and "in a Tank" status, and one-click
  drop-in to friends' Tanks (the host can turn this off per Tank).
- **Disposable rooms.** Tanks start in about 3 seconds and close when the host drains them,
  after an idle timeout or after a maximum lifetime.
- **Hardened for the internet.** argon2id passwords, optional TOTP 2FA, rate limits, CSRF
  protection, a separate origin for Tank browsers, an allowlisting Docker API gate, and an
  egress firewall that keeps Tanks off your LAN.
- **Admin dashboard.** Live Tanks with CPU and memory use, account management and an invite log.

> **Not supported:** Netflix, Disney+, Prime Video and other Widevine DRM services do not play
> in containerized browsers.

---

## Contents

1. [How it works](#how-it-works)
2. [Requirements](#requirements)
3. [Quick start (local trial)](#quick-start-local-trial)
4. [Production setup](#production-setup)
5. [Configuration reference](#configuration-reference)
6. [Operations](#operations)
7. [Security model](#security-model)
8. [Development](#development)
9. [Troubleshooting](#troubleshooting)
10. [Project layout](#project-layout)

---

## How it works

```text
                        ┌──────────────────────── Docker host ────────────────────────┐
 Browser ──HTTPS 443──► │ Caddy ──fishtank.example.com──► fishtank-app :3000          │
                        │   │                               │  API, web UI, WebSocket,  │
                        │   │                               │  orchestrator, SQLite     │
                        │   │                               ▼                          │
                        │   │                      fishtank-docker-gate (allowlist)    │
                        │   │                               │                          │
                        │   │                               ▼  /var/run/docker.sock    │
                        │   └─tanks.example.com/<id>/──► tank-<id> (Neko + Firefox)    │
                        │        forward_auth → app          ▲                          │
 Browser ──UDP 590xx──────────────────────────────────────────┘  WebRTC media          │
                        │ fishtank-egress: iptables rules keeping Tanks off the LAN    │
                        └──────────────────────────────────────────────────────────────┘
```

| Component | What it does |
| --- | --- |
| **fishtank-app** | Node 24 + TypeScript (Fastify) API, the React web UI, live WebSocket notifications, and the orchestrator that starts, watches and reaps Tanks. Data lives in SQLite (`node:sqlite`) on the `fishtank-data` volume. |
| **fishtank-docker-gate** | The app's only route to Docker. A small proxy (`docker-gate/policy.mjs`) that only creates containers matching a strict Tank template and only touches containers labelled as Tanks. Exec, volumes, networks, builds and other containers are refused. |
| **fishtank-egress** | Runs in the host network namespace and adds `DOCKER-USER` iptables rules so Tanks reach the internet and DNS, but not private addresses (LAN, router, Docker host, other containers) except an explicit allowlist. |
| **tank-\<id\>** | A [Neko](https://github.com/m1k1o/neko) browser container per room, created on demand. Not in the compose file. |
| **Caddy** (yours) | TLS termination and routing. Serves the app on one hostname and the Tanks on a second hostname, checking every Tank request with the app (`forward_auth`) first. |

**Docker networks** (created by the compose file with fixed subnets):

| Network | Subnet | Members |
| --- | --- | --- |
| `fishtank-edge` | `10.88.1.0/24` | app, Caddy |
| `fishtank-tanks` | `10.88.2.0/24` | app (`.2`), Caddy (`.3`), Tanks (`10.88.2.128/25`) |
| `fishtank-internal` | `10.88.3.0/24`, internal | app, docker-gate |

**Tank lifecycle:** the host names a Tank. The app checks quotas, takes a free UDP port from
the pool and starts `tank-<uuid>` through the gate, with CPU, memory and PID limits, no
volumes and dropped capabilities. Members open it in an iframe on the Tank origin. Each
person gets their own Neko login with their own permissions (the host is the Neko admin,
guests can never take control), and passwords never reach the browser. A Tank closes when
the host drains it, when nobody has been connected for `TANK_IDLE_MINUTES`, after
`TANK_MAX_HOURS`, or when an admin closes it. On startup the app reconciles Docker against
the database and removes orphaned Tanks.

A fuller design write-up, including past security reviews, is in [docs/PLAN.md](docs/PLAN.md).

---

## Requirements

- **Docker** with Compose v2: Docker Desktop on Windows or macOS, or Docker Engine on Linux.
  The egress firewall uses `iptables-nft` inside the Docker host, which is what Docker
  Desktop's VM and most current Linux distributions use. See [Troubleshooting](#troubleshooting)
  if your host uses legacy iptables.
- **CPU.** Each Tank encodes video in software (VP8). Budget about **6 CPU threads and 3 GB RAM
  per Tank** at 720p30; 2 CPUs gave choppy video and dropped audio in testing. A 16-thread
  machine runs 2–3 Tanks comfortably.
- **A public IPv4 address** (not CGNAT) or another way to receive inbound UDP. WebRTC media goes
  straight to the host on one UDP port per Tank.
- **A domain name** with two hostnames pointing at your public IP: one for the app and one for
  the Tank browsers (a wildcard record covers both). Dynamic DNS is fine.
- **Caddy v2 running in Docker** (or another reverse proxy that supports `forward_auth`-style
  subrequests and WebSockets, which you'd configure yourself).
- For development only: Node.js 24+.

---

## Quick start (local trial)

This runs the app, accounts, friends and admin UI on your own machine without a domain.
**Tanks need the reverse-proxy setup in [Production setup](#production-setup)**, because they
are served from a separate origin through Caddy.

```sh
git clone <this repo> fishtank && cd fishtank
cp .env.example .env
```

Edit `.env` for local HTTP:

```ini
APP_ORIGIN=http://localhost:3080
COOKIE_SECURE=false
```

Start it and get the first admin code:

```sh
docker compose up -d --build
docker logs fishtank-app        # look for "No accounts exist yet ... one-time code"
```

Open <http://localhost:3080>, choose **Create account**, and use that code as the
**Sign-up code**. The first account becomes the admin. The bootstrap code is valid for 24
hours and is printed again (as a new code) on every restart until an account exists.

---

## Production setup

### 1. DNS

Create records pointing at your public IP, for example:

| Record | Value |
| --- | --- |
| `fishtank.example.com` | your public IP (the app) |
| `tanks.example.com` | your public IP (Tank browsers) |

A wildcard `*.example.com` works too. If your IP changes, run a dynamic DNS updater.

### 2. Router port forwards

Forward to the Docker host:

| Port | Protocol | Purpose |
| --- | --- | --- |
| 80, 443 | TCP | Caddy (HTTPS + Let's Encrypt) |
| 59000–59009 | UDP | WebRTC media, one port per Tank (`TANK_UDP_PORTS`) |

The UDP range must be at least `MAX_TANKS` ports wide.

### 3. Host firewall

Allow the same ports inbound on the host's firewall.

**Windows (Docker Desktop):** Docker Desktop's automatic firewall rules may only cover the
*Public* profile. If your network is set to *Private*, add a rule yourself in an
**elevated** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "FishTank Tanks UDP 59000-59009" -Direction Inbound `
  -Protocol UDP -LocalPort 59000-59009 -Action Allow -Profile Any
```

Connections from the host machine itself skip the firewall, so test from a phone on mobile
data or from another network.

### 4. Configure FishTank

```sh
cp .env.example .env
```

At minimum, set:

```ini
APP_ORIGIN=https://fishtank.example.com
TANK_ORIGIN=https://tanks.example.com
TANK_PUBLIC_HOST=example.com          # any name/IP that resolves to your public IPv4
TZ=America/New_York                   # logs + backup filenames
TANK_TIMEZONE=America/New_York        # Tank browser clock; match your IP's location
```

If Tanks should reach media servers on your LAN (Jellyfin, Plex…), allow them explicitly and,
optionally, add start-page tiles for them:

```ini
TANK_ALLOW_DESTINATIONS=192.168.1.50:8096 192.168.1.50:32400
TANK_START_TILES=[{"title":"YouTube","url":"https://www.youtube.com/"},{"title":"Jellyfin","url":"http://192.168.1.50:8096/"}]
```

Use **LAN IP addresses** in both, not hostnames that resolve to public addresses. Everything
else in private address space stays blocked.

See the full [Configuration reference](#configuration-reference).

### 5. Start the stack

```sh
docker compose up -d --build
docker compose ps                 # app should become "healthy"
docker logs fishtank-app          # first-run admin code
```

This creates the `fishtank-edge`, `fishtank-tanks` and `fishtank-internal` networks, which
Caddy joins in the next step. The app pulls the Neko image on startup (and again daily), so
the first start can take a minute.

> **Subnet clash?** If `10.88.1.0/24`–`10.88.3.0/24` are already in use, change them in
> `docker-compose.yml` and keep these in sync: `TRUST_PROXY` (the edge subnet), the app's
> `ipv4_address` and `ip_range` on the Tank network, the egress `TANK_SOURCE_RANGE`, and
> Caddy's fixed address.

### 6. Reverse proxy (Caddy)

1. Attach your Caddy container to the FishTank networks. In **Caddy's** compose file:

   ```yaml
   services:
     caddy:
       networks:
         default: {}
         fishtank-edge: {}
         fishtank-tanks:
           ipv4_address: 10.88.2.3   # outside the Tank range 10.88.2.128/25
   networks:
     fishtank-edge:
       external: true
     fishtank-tanks:
       external: true
   ```

2. Add the two site blocks from [`caddy/fishtank.caddy`](caddy/fishtank.caddy) to your
   Caddyfile, replacing `fishtank.example.com` and `tanks.example.com` with your own names
   (also in the `frame-ancestors` header).

3. Validate and reload:

   ```sh
   docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
   docker compose up -d          # in Caddy's project, to join the networks
   docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile
   ```

What the blocks do:

- **App site:** proxies everything to `fishtank-app:3000`, except `/auth/*`, which returns 404.
  That endpoint is for Caddy's internal subrequests only.
- **Tank site:** only accepts `/<uuid>/...` paths. Each request first goes to
  `forward_auth fishtank-app:3000 /auth/tank/<uuid>`, which checks the per-Tank pass cookie,
  membership and that the Tank is open. Only then is it proxied to `tank-<uuid>:8080`.
  `Connection`/`Upgrade` headers are stripped from the auth subrequest so WebSockets work.

### 7. Create the admin account

Open `https://fishtank.example.com`, choose **Create account** and use the one-time code from
`docker logs fishtank-app`. Then:

- Turn on **2FA** for the admin account (Account page). It's strongly recommended.
- Make `FISH-` sign-up codes for friends from the home page (members get 5 active codes;
  admins have no limit).
- Start a Tank, then check that video plays for someone **outside** your network.

---

## Configuration reference

All settings go in `.env`. Defaults apply when a variable is unset.

### App

| Variable | Default | Description |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:5173,http://localhost:3000` | Comma-separated origins allowed to make state-changing requests (CSRF guard). The first is used in invite links. Set it to your public HTTPS URL. |
| `TRUST_PROXY` | off | CIDR(s) of the reverse proxy, so the app trusts `X-Forwarded-For` (real client IPs for rate limits and sessions). `10.88.1.0/24` with the default compose file. |
| `SESSION_DAYS` | `30` | Sliding session lifetime. |
| `COOKIE_SECURE` | `true` | Set to `false` only for plain-HTTP local tests. |
| `TZ` | `UTC` | Time zone for logs and backup filenames (read by `docker-compose.yml`). |
| `BACKUP_DIR` | unset (off) | Directory for nightly SQLite backups. The compose file mounts `./backups` at `/backups`. |
| `BACKUP_KEEP` | `14` | Number of backups to keep. |

### Tanks

| Variable | Default | Description |
| --- | --- | --- |
| `TANK_ORIGIN` | `http://localhost:8081` | Public origin for Tank browsers. **Must be a different hostname from the app**, which keeps Tank pages away from app cookies. |
| `TANK_PUBLIC_HOST` | `127.0.0.1` | Hostname or IP viewers use for WebRTC media. Resolved to a single IPv4 address when each Tank starts (Neko's NAT 1:1 mapping needs one IP), so DDNS names work. |
| `TANK_UDP_PORTS` | `59000-59009` | UDP port pool, one port per Tank. Also passed to the Docker gate, which refuses any other port. |
| `MAX_TANKS` | `4` | Concurrent Tanks across the server. |
| `TANKS_PER_HOST` | `1` | Concurrent Tanks one user can host. |
| `TANK_CPUS` | `6` | CPU limit per Tank (the gate caps it at 8). |
| `TANK_MEMORY_GB` | `3` | Memory limit per Tank (the gate caps it at 6). |
| `TANK_SCREEN` | `1280x720@30` | Neko desktop resolution and frame rate. 1080p roughly doubles the CPU cost. |
| `TANK_IMAGE` | `ghcr.io/m1k1o/neko/firefox:3` | Neko image. The start page, bookmarks and browser tweaks are written for Firefox. |
| `TANK_IDLE_MINUTES` | `15` | Close a Tank after this long with no one connected. |
| `TANK_MAX_HOURS` | `8` | Maximum Tank lifetime. |
| `TANK_PREVIEW_MINUTES` | `10` | How often to refresh each Tank's home-page screenshot (`0` = off). Kept in memory only. |
| `TANK_ALLOW_DESTINATIONS` | empty | Space-separated `ip:port` (TCP) LAN services Tanks may reach. All other private addresses are blocked. Applied by the egress container. |
| `TANK_START_TILES` | YouTube only | JSON array of `{"title","url"}` shown on the Tank start page and bookmarks bar. |
| `TANK_TRUSTED_SITES` | empty | Space-separated domains where Firefox tracking protection and uBlock Origin are disabled (Twitch's login needs this). |
| `TANK_WEBGL_GPU` | an NVIDIA string | `vendor\|renderer` the Tank's Firefox reports through WebGL instead of the software renderer, which some login bot checks reject. Empty = report the real one. |
| `TANK_TIMEZONE` | `TZ` | Tank browser time zone. Match it to your public IP's location, because some sites flag mismatches. |

Changing `TANK_ALLOW_DESTINATIONS` or `TANK_UDP_PORTS` needs the services that read them
recreated:

```sh
docker compose up -d app docker-gate egress
```

### Recording (optional)

Off by default. When it's on, admins can record a Tank they're in, and every account can watch
the recordings until they're wiped. See [docs/RECORDING.md](docs/RECORDING.md) for how it works.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPOSE_PROFILES` | empty | Set to `recording` to start the recorder container. |
| `RECORDING_ENABLED` | `false` | `true` turns on the app and firewall side. Set this **and** `COMPOSE_PROFILES`. |
| `RECORDING_KEEP_DAYS` | `7` | Days after a recording **ends** before it is wiped. |
| `RECORDING_MAX_HOURS` | `TANK_MAX_HOURS` | Longest single recording. |
| `RECORDING_VIDEO_KBPS` / `RECORDING_AUDIO_KBPS` | `2500` / `128` | Recording bitrates. 2500 kbps is about 1.2 GB per hour. |
| `RECORDING_PRESET` | `veryfast` | x264 speed preset. Slower presets give smaller files but use more of the Tank's CPU. |
| `RECORDINGS_PATH` | empty | A host folder for recordings, e.g. `D:/FishTank/recordings`, instead of the `fishtank-recordings` Docker volume. On Linux it must be writable by uid 1000. |
| `RECORDING_MIN_FREE_GB` | `10` | Refuse to start a recording when the recordings disk has less free space. |
| `RECORDING_CLIP_SECONDS` | `60` | Length of a clip ("Clip the last minute"). |
| `RECORDING_TANK_URL` | `http://10.88.2.2:3001` | Where a Tank's browser opens recordings shared to it ("Watch together"). Change it only with the Docker subnets. |

Only Tanks opened after recording is turned on can be recorded, because the recording settings
are fixed when a Tank starts. Encoder settings apply to Tanks opened after the change.

**Clips.** While a Tank is being recorded, anyone in it with an account (not guests) can press
**✂ Clip the last minute**. The last 60 seconds are saved as their own short recording, marked
**CLIP**. It's listed under Recordings, can be played in Tanks, and is wiped after
`RECORDING_KEEP_DAYS` like the rest. A clip is about 20 MB. The recorder cuts it from what it has
already saved, without re-encoding, so it costs no extra CPU. Clipping only works while
recording, so it can't reach back to before Record was pressed.

**Watch together.** Every finished recording can be played inside any open Tank, so everyone there
watches it on the Tank's screen, guests included, with the usual control. In the Tank's browser,
**Recordings** on the bookmarks bar lists them all. Tanks opened before recording was turned on
have no bookmark, so type `http://10.88.2.2:3001` in their address bar. Accounts can also press
**Open in Tank** (in the Tank's side panel or on a recording's page), and the recording opens on
the Tank's screen by itself. That page answers only open Tanks, so its links don't work anywhere else.

**Disk space.** Recordings go in the `fishtank-recordings` Docker volume, or in the host folder
set by `RECORDINGS_PATH` (use it to put them on a bigger drive). At the default bitrates
a recording takes about **1.2 GB per hour** (a quiet screen takes less). Plan for the most you
expect to record within `RECORDING_KEEP_DAYS`. For example, 3 hours a night kept for 7 days is
about 25 GB. When free space drops below `RECORDING_MIN_FREE_GB`, new recordings are refused.
The Admin page shows how much space recordings use and how much is free. Recordings are not in
the nightly backups.

**CPU.** Recording encodes the Tank's screen a second time, inside the Tank. That costs about
0.7–1.5 extra cores while recording, which `TANK_CPUS=6` covers.

**Privacy.** Turning recording on changes what people can expect from FishTank: normally nothing
in a Tank outlives it.

- A recording keeps everything on the Tank's screen: signed-in accounts, emails, chat windows and
  anything typed where it shows. Only the Tank's own sound is recorded, not your microphones or
  voice chat in other apps.
- Everyone in a Tank sees a red **REC** badge while it's recorded, with a message naming the
  admin who started it. People opening an invite link are warned before they join.
- Every account (not guests) can watch every recording until it's wiped. Anyone who watches can
  save their own copy, as with any web video, so a wipe only deletes the server's copy.
- Tell the people you invite that you have recording turned on.

**Other people's content.** Recording your own media (for example your Jellyfin or Plex library)
is up to you. Recording streaming services such as YouTube, Twitch or Netflix usually breaks
their terms of service and may infringe copyright. Whether you allow it on your server is your
decision and your responsibility.

---

## Operations

### Everyday commands

```sh
docker compose up -d --build      # start / apply changes
docker compose logs -f app        # app logs
docker compose ps                 # health
docker ps --filter name=tank-     # running Tanks
docker compose down               # stop the stack
```

Tank containers aren't part of the compose project, so `docker compose down` leaves running
Tanks behind (and can't remove `fishtank-tanks` while they're attached). Close them from the
Admin page first, or remove them directly:

```sh
docker rm -f $(docker ps -aq --filter label=fishtank.managed=true)
```

If the app restarts while Tanks are running, it reconciles on startup: containers with no open
Tank are removed, and open Tanks with no container are marked closed.

### Updating

```sh
git pull
docker compose up -d --build
```

Database migrations run automatically on startup. The Neko image is re-pulled on startup and
daily, so new Tanks get Firefox security updates.

### Backups

With `BACKUP_DIR` set, the app writes `./backups/fishtank-<timestamp>.sqlite` once a day and
keeps the newest `BACKUP_KEEP`. Backups contain **password hashes, TOTP secrets and the app's
signing keys**. Keep them private and copy them off the machine regularly.

To restore one:

```sh
docker compose stop app
docker run --rm -v fishtank-data:/data -v "$PWD/backups:/backups" alpine sh -c \
  'rm -f /data/fishtank.sqlite-wal /data/fishtank.sqlite-shm && cp /backups/<file>.sqlite /data/fishtank.sqlite && chown 1000:1000 /data/fishtank.sqlite'
docker compose start app
```

### Moving to another machine

Copy the project folder (with `.env`) and restore the `fishtank-data` volume, or a backup as
shown above. Then update DNS, port forwards and the host firewall. Tanks are ephemeral, so
there is nothing else to move.

### Admin tasks

The **Admin** page (`/admin`) shows live Tanks with CPU and memory use (close any of them),
all accounts with online, 2FA and last-seen status (disabling an account signs it out, drains
its Tanks and removes it from others' Tanks), every sign-up code, live guests, and an invite
log.

---

## Security model

FishTank is built to sit on the public internet for a **trusted group of friends**. Anyone in
a Tank can see whatever is logged in there. Treat the Tank as a shared screen and don't log in
to personal accounts you wouldn't share with the room. Control is locked to the host by default.

- **Accounts:** invite-only (`FISH-` codes, hashed, single-use, expiring), argon2id password
  hashing, server-side sessions in `HttpOnly; Secure; SameSite=Lax` cookies, `Origin` checks on
  state-changing requests, generic login errors, optional TOTP 2FA with recovery codes.
- **Rate limits:** login (per username plus a global failure cap), registration, and guest joins
  (per client IP).
- **Guests:** a default-deny API allowlist, watch-only Neko permissions, and deletion when they
  leave, disconnect for 2 minutes, are removed, or the Tank closes.
- **Tank isolation:** a separate origin, `forward_auth` on every request, per-person Neko logins
  whose passwords never reach the browser (a single-use 60-second ticket is exchanged
  server-side), and `frame-ancestors` limited to the app.
- **Containers:** Tanks run with `no-new-privileges`, dropped `NET_RAW`/`MKNOD`/`AUDIT_WRITE`,
  CPU, memory and PID limits, and no host mounts. The Docker gate enforces this template, so
  even a compromised app can't start anything else. The gate is read-only, has no
  capabilities and is reachable only on an internal network.
- **Network:** the egress firewall blocks Tanks from `10/8`, `172.16/12`, `192.168/16`,
  `100.64/10` and `169.254/16` except `TANK_ALLOW_DESTINATIONS`. Its rules stay in place if the
  egress container stops (fail closed) and are re-applied if Docker resets them.
- **Recording (when on):** a Tank can send video only to the recorder's RTMP port. The recorder
  accepts a stream only after the app confirms the recording is live, the stream key is right
  (a new random key for every recording), and the stream comes from the Tank range. The recorder can't reach the
  internet or your LAN; it can only call the app. Its playback server (used to cut clips) accepts
  only the app, with a secret that lives in the app's memory, and Tanks can't reach its port. Recordings are served only to signed-in
  accounts, never cached, and wiped when they expire.

**Recommendations:**

- Turn on 2FA for admin accounts.
- Don't attach other services to `fishtank-tanks`. Reach them by LAN IP through the allowlist.
- Keep `.env` and `backups/` private. Both are git-ignored.

---

## Development

```sh
npm install
cp .env.example .env              # dev server reads ../../.env if present
npm run dev:server                # API on http://127.0.0.1:3000 (node --watch)
npm run dev:web                   # Vite on http://localhost:5173, proxies /api
```

For dev, set `APP_ORIGIN=http://localhost:5173` and `COOKIE_SECURE=false`. Starting Tanks from
a dev server needs Docker access (unset `DOCKER_HOST` uses the local socket or pipe) and the
proxy setup above.

```sh
npm test                          # server tests (node:test)
node --test docker-gate/policy.test.mjs   # Docker gate policy tests
npm run typecheck                 # server + web
```

The server runs TypeScript directly through Node's type stripping, so it has no build step.
The web UI is React + Vite.

### Neko spike

`spike/` holds a standalone single-Neko compose file for testing stream quality on new
hardware before running the full stack. See the comments in
[`spike/docker-compose.yml`](spike/docker-compose.yml).

---

## Troubleshooting

**"all predefined address pools have been fully subnetted"**: your Docker host is out of
default network ranges. FishTank already uses explicit subnets. If they clash with existing
networks, change them (see [step 5](#5-start-the-stack)).

### Video never starts for remote viewers, or only works on the LAN

- Check that the UDP range is forwarded to the host **and** allowed by the host firewall. On
  Windows, check the network profile (Private vs Public).
- `TANK_PUBLIC_HOST` must resolve to your **public** IPv4 address *inside the app container*.
  The app uses public DNS resolvers (`1.1.1.1`) because split-horizon LAN DNS (e.g. Pi-hole)
  would return the LAN IP. Check with
  `docker exec fishtank-app node -e "require('dns').lookup('example.com',(e,a)=>console.log(a))"`.
- If LAN viewers can't connect but remote ones can, your router may not support hairpin NAT.
- Strict NAT or firewalled viewers may need a TURN server, which isn't included yet.

**Tank page shows 401 or 404**: the Tank site only answers `/<uuid>/` paths with a valid pass.
Open Tanks from the app instead of copying the Tank URL. If every Tank 404s, check that Caddy
is on `fishtank-tanks` and can resolve `tank-<uuid>`.

**Tank can't reach a LAN service**: add `ip:port` to `TANK_ALLOW_DESTINATIONS`, use the LAN
**IP** in the URL, and recreate the services with `docker compose up -d app egress`. Check
the rules with `docker logs fishtank-egress`.

**Egress container fails on a Linux host with legacy iptables**: `egress/egress.sh` calls
`iptables-nft`. If your host's Docker uses `iptables-legacy`, change `IPT=` at the top of the
script and rebuild (`docker compose up -d --build egress`). Check afterwards that Tanks can't
reach your router.

**A site says "browser not supported" at login (e.g. Twitch)**: keep `TANK_WEBGL_GPU` set,
set `TANK_TIMEZONE` to match your IP's location, and add the site to `TANK_TRUSTED_SITES`.
Logins never persist, because every Tank is a new device.

**Choppy video or audio dropouts**: raise `TANK_CPUS` or lower `TANK_SCREEN`. Watch per-Tank
CPU on the Admin page.

**Lost the admin code**: it's only printed while no accounts exist. Restart the app
(`docker compose restart app`) for a fresh one.

---

## Project layout

```text
apps/
  server/            Fastify API, orchestrator, SQLite (src/), tests (test/)
  web/               React + Vite UI
docker-gate/         Allowlisting Docker API proxy + policy tests
egress/              Tank egress firewall (iptables)
caddy/               Example Caddy site blocks
spike/               Standalone Neko test room
docs/PLAN.md         Design notes, roadmap and security reviews
docker-compose.yml   app + docker-gate + egress, networks, data volume
Dockerfile           App image (builds the web UI, runs the server)
.env.example         Configuration template
```

---

## License

FishTank is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).
You're free to use, self-host, modify and share it for **noncommercial** purposes:
personal use, friend groups, hobby projects, and noncommercial organizations.
Commercial use, including selling it, offering it as a paid service, or using it inside a
business, needs separate permission from the author.

Required Notice: Copyright 2026 BoatLeek (https://github.com/MMajor87)

---

## Credits

Tank browsers are [Neko](https://github.com/m1k1o/neko) by m1k1o and contributors (Apache-2.0),
pulled as `ghcr.io/m1k1o/neko/*` images at runtime.
