# FishTank — Plan

FishTank is a self-hosted, internet-facing service for small watch parties. Each
**Tank** (room) is a throwaway browser running in its own Docker container,
streamed to everyone in the room over WebRTC (via [Neko](https://neko.m1k1o.net)).
Members load YouTube, Plex, Jellyfin, etc. inside it. When the Tank closes, the
container and everything in it — cookies, logins, history — is destroyed.

Rooms are never listed publicly. You only reach a Tank by being invited, either
**internally** (sent to a FishTank friend) or **externally** (a generated invite code).

---

## 1. Decisions so far

| Topic | Decision |
|---|---|
| Hosting | Docker Compose, behind an existing Caddy reverse proxy on 80/443. Developed on Windows with Docker Desktop; designed to move to a Linux host by copying the compose project + data volume. |
| Access | Internet-facing: HTTPS on 443, a public domain (or dynamic DNS), forwarded UDP range for WebRTC. |
| Browser engine | Neko v3 images (`ghcr.io/m1k1o/neko/firefox` default; `chromium` optional). We do not build our own streaming. |
| Accounts | Permanent accounts (friends, hosting) come only from `FISH-` sign-up codes, which any member can send. People invited to a single Tank by link watch as **temporary guests**: no account, random name, watch only, deleted when they leave. |
| Room discovery | No public listing. A live Tank is visible to its members and to the **host's friends**, who can drop in without an invite. The host can switch this off per Tank ("Friends can drop in"), after which only invited people see it. |
| Content scope | YouTube, Plex, Jellyfin and other non-DRM sites. Netflix / Disney+ / Prime etc. are **out of scope** (Widevine DRM blocks them in containerized browsers). |
| Hardware (reference) | 16 threads, 48 GB RAM → CPU encoding comfortably handles several concurrent Tanks; NVIDIA Neko images are an optional later experiment. |

---

## 2. Architecture

```
 Internet ──443/tcp──► existing Caddy ─────────────► fishtank-app  (API + web UI + orchestrator)
                         │  /tank/<id>/*                │   SQLite (users, friends, tanks, invites)
                         │  forward_auth ──────────────►│   checks session cookie + membership
                         ▼                              │
                   tank-<id> (Neko)  ◄──────────────────┘ creates / destroys via docker-socket-proxy
 Internet ──UDP 59000-590xx──► one UDP port per Tank (Neko UDPMUX)
```

**Reverse proxy:** the host already runs Caddy on 80/443 (`caddy:alpine`, its own compose project). FishTank reuses it instead of adding Traefik:
- Add a site block for the FishTank domain to that Caddyfile (example in `caddy/fishtank.caddy`).
- Attach Caddy to a shared external Docker network `fishtank-edge`, which the app and all Tank containers also join.
- Routing: `/tank/<id>/*` → `forward_auth fishtank-app:3000 { uri /auth/tank }` → `reverse_proxy tank-{id}:8080` (upstream taken from the path via a regex placeholder; ids are validated as UUIDs). Everything else goes to `fishtank-app:3000`.
- Caddy handles TLS (Let's Encrypt) automatically.
- When migrating to a dedicated machine, either bring a Caddy along or keep the same Caddyfile snippet.

**Docker networks:** the development host had used up Docker's default address pools (31 networks). FishTank therefore creates its networks with **explicit subnets** (e.g. `fishtank-edge` = `10.88.1.0/24`), and all Tanks share that one network rather than getting a network each. This also means room count is never limited by network count.

Services in FishTank's `docker-compose.yml`:
- **fishtank-app**: one Node.js/TypeScript container (Fastify API, serves the built React UI, runs the orchestrator and the reaper loop).
- **docker-socket-proxy**: lets the app create/start/stop/remove containers and nothing else. The app never mounts the raw Docker socket.
- **tank-\<id\>**: Neko containers created on demand. They are not in the compose file.
- **coturn** (optional, Phase 3): TURN relay for guests behind strict NAT.

Stack: Node 24 + TypeScript (run directly via Node type stripping, no server build step), Fastify, `dockerode`, SQLite via built-in `node:sqlite` with plain-SQL migrations (no ORM), argon2id via `@node-rs/argon2`, React + Vite, WebSocket for live notifications.

---

## 3. Accounts, friends, and invites

### Registration (internet-facing, so it is gated)
Every account can spin up containers that burn CPU, so open signup is a risk.
- **Invite-only registration.** A new permanent account needs a `FISH-` sign-up code. Any member can make them from the home page (5 active at a time; admins unlimited). Who made the code is recorded as the account's inviter; the Admin page shows it, plus everyone's codes.
- **Temporary guests.** Opening a `TANK-` invite link while logged out offers "Watch as a guest": a guest account with a random name ("Sleepy Pufferfish 42"), bound to that one Tank, using one use of the code. Guests can only call the few API routes needed to watch (default-deny allowlist), can't log in, be friended, host, or control the browser (their Neko login has `can_host: false`). A guest is deleted when they leave, are removed, are disconnected for 2 minutes, or the Tank closes. The Admin page lists live guests and keeps an invite log (accounts and guests, who invited them, when a guest pass ended and why).
- Roles: `admin`, `member`. Admins can disable accounts, view running Tanks and kill them.
- Per-user limit on concurrent hosted Tanks (default 1); global cap on concurrent Tanks (default 6 on current hardware).

### Auth & security
- Passwords hashed with **argon2id**. Optional **TOTP 2FA** (Phase 4).
- Server-side sessions; cookie is `HttpOnly; Secure; SameSite=Lax`. CSRF guarded by SameSite + `Origin` check on state-changing requests.
- Rate limiting on login, register, and invite-code redemption (codes are brute-forceable otherwise).
- Generic error messages on login (no username enumeration).

### Friends
- Add by username (or a personal friend code). Requests are `pending → accepted`, and either side can remove. Users can **block**.
- The friends list shows online status and "in a Tank" status (only to friends).

### Invites — two paths into a Tank
1. **Internal invite:** the host picks friends, and they get a live notification plus an entry in their Invites inbox. Accepting adds them as a Tank member.
2. **External invite code:** the host generates a code like `TANK-7KQ2-M9XD` (Crockford base32, ~50 bits). Options: expiry (default 24 h or Tank close), max uses (default 1), revocable. The share link is `https://<domain>/join/TANK-7KQ2-M9XD`. Logged-in people join as themselves; everyone else joins as a temporary guest (TANK codes no longer create accounts).

### Data model (SQLite)
```
users           id, username (unique), display_name, password_hash, role, disabled,
                totp_secret?, created_at
sessions        id (random 256-bit), user_id, expires_at, last_seen_at, ip, user_agent
registration_codes  code, created_by, expires_at, used_by?, used_at?
friendships     user_low_id, user_high_id, status (pending|accepted|blocked),
                requested_by, created_at                 -- one row per pair
tanks           id (uuid), name, host_id, status (starting|open|closing|closed),
                browser, container_id?, udp_port?, created_at, last_active_at,
                closes_at, closed_at?
tank_members    tank_id, user_id, role (host|guest), joined_at
invite_log      kind (account|guest), user + inviter names (copied), tank_name, created_at, ended_at, end_reason
                -- users also has guest_tank_id (set = temporary guest) and invited_by
tank_invites    id, tank_id, created_by, kind (direct|code),
                invited_user_id?   -- direct
                code_hash?         -- code (store a hash, not the code)
                expires_at, max_uses, uses, revoked_at?
```
The Neko room passwords are generated when a Tank is created and kept **in memory only**. They are never written to disk and die with the Tank.

---

## 4. Tank lifecycle

1. **Create:** the host names the Tank and picks a browser. The app checks quotas, allocates a free UDP port from the pool, and generates random Neko user/admin passwords. It then starts `tank-<id>` with:
   - `--rm`-style cleanup, no volumes; browser profile on **tmpfs**
   - CPU/RAM limits (e.g. 2 CPU / 3 GB), `shm_size: 2gb`
   - `NEKO_WEBRTC_UDPMUX=<port>` + `NEKO_WEBRTC_NAT1TO1=<public host>`
   - `NEKO_SERVER_PATH_PREFIX=/tank/<id>`, `NEKO_SERVER_PROXY=true`
   - `NEKO_SESSION_CONTROL_PROTECTION=true` (control only when the host/admin is present)
   - `NEKO_CAPTURE_MICROPHONE_ENABLED=false`, `NEKO_CAPTURE_WEBCAM_ENABLED=false` (viewers use external voice apps; no upstream media)
   - `NEKO_DESKTOP_SCREEN=1280x720@30`, CPU limit ~4–6 cores (software VP8 at 2 cores stuttered in the spike)
   - joined to `fishtank-edge` so Caddy can reach it as `tank-<id>:8080`
   - egress restricted by the Tank firewall rules (see §5)
2. **Invite:** direct and/or code invites (see §3).
3. **Join:** a member opens the Tank page and the app gives them the Neko credentials for their role (host → Neko admin, others → user). The Neko client is embedded in the FishTank UI.
4. **Close**, whichever comes first:
   - the host clicks **Drain the Tank**
   - nobody connected for **15 min** (idle)
   - max lifetime reached (**8 h**, configurable)
   - an admin kills it

   On close: `docker rm -f`, free the port, mark the Tank `closed`, expire its invites.
5. **Reconcile on startup:** remove any `tank-*` container without an open Tank row, and mark open Tanks with no container as closed.

---

## 5. Security hardening (required before exposing to the internet)

- **Egress isolation:** Tank containers sit on their own Docker network. Outbound traffic to private ranges (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10) is blocked **except** an allowlist (your Plex/Jellyfin hosts). Without this, a guest could browse to your router admin page or other LAN services. Plex/Jellyfin are best reached by their public/remote URL anyway.
- **Docker socket** only via `docker-socket-proxy` with `CONTAINERS=1, POST=1`, everything else off.
- **Caddy forward_auth on every Tank request.** A leaked Neko password alone is useless without a FishTank session belonging to a member.
- Tank containers run without extra privileges (`no-new-privileges`), with resource limits and no host mounts.
- **Shared-login warning in the UI:** whoever logs into Plex/YouTube inside a Tank is trusting everyone with control. The host holds control by default.
- Backups: nightly copy of the SQLite DB volume.

---

## 6. Networking checklist

- Domain or dynamic DNS (e.g. DuckDNS, Cloudflare) pointing at your public IP.
- Router port forwards to this PC:
  - **TCP 80, 443** → Caddy
  - **UDP 59000–59009** → one port per Tank (10-Tank pool; widen as needed)
- Windows Defender Firewall: allow the same ports for Docker Desktop.
- If the ISP uses CGNAT (no real public IPv4), you need coturn on a VPS or a tunnel. Check this early.

---

## 7. Roadmap

| Phase | Goal | Done when |
|---|---|---|
| **0: Spike** | Prove Neko works on this hardware | `spike/` Tank plays YouTube + Plex/Jellyfin smoothly with audio for 2–3 viewers, including one **outside** your network. |
| **1: Accounts** | App skeleton + auth | monorepo, compose with app + Caddy site block, register/login/logout, sessions, registration codes, admin user bootstrap. |
| **2: Friends & invites** | Social graph | Friend requests/accept/block, live notifications, invites inbox, code generation/redemption. |
| **3: Orchestrator** | Tanks on demand | Create/close Tanks, port pool, forward-auth, idle/lifetime reaper, startup reconcile, embedded Neko client. |
| **4: Hardening** | Safe on the internet | Egress firewall, socket proxy, rate limits, TOTP, Let's Encrypt, coturn if needed, backups. |
| **5: Polish** | Pleasant | Start-page tiles (YouTube/Plex/Jellyfin), pre-warmed Tank pool, admin dashboard (running Tanks, CPU), Tank themes. |

## 8. Migrating to another machine later
Copy the project folder and `.env`, then restore the `fishtank-data` volume (SQLite). On a Linux host, the socket proxy points to `/var/run/docker.sock` (same as Docker Desktop's Linux VM). Update DNS and port forwards. Tanks are ephemeral, so there is nothing else to move.

---

## 9. Status & running it

| Phase | Status |
|---|---|
| 0: Spike | ✅ Done 2026-11-12. Neko Firefox at 720p / 6 CPUs runs YouTube + Jellyfin smoothly; mic/webcam off; host has public IPv4 (no CGNAT). External-viewer test done 2026-11-15 (video works for a viewer outside the home network). |
| 1: Accounts | ✅ Core done: invite-only registration (`FISH-` codes, hashed, single-use, 72h), argon2id, server-side sessions, Origin-check CSRF guard, rate limits, first-run admin bootstrap code, web UI, Docker image. Caddy site block in `caddy/fishtank.caddy`, applied in the host's Caddy once the domain went live (see Domain). |
| Domain | ✅ App and Tank origins live via the host's Caddy (Let's Encrypt). DNS: `@` and `*` → public IP, kept current by a dynamic DNS updater. |
| 2: Friends & invites | ✅ Done 2026-11-12: friend requests by username (mutual = auto-accept), accept/decline/cancel/remove, blocking (hidden from blocked user), live WebSocket `/api/ws` (Origin-checked, cookie auth, 30s heartbeat re-validates session, logout closes sockets), presence for friends only, toasts. Tank invite inbox moves to Phase 3 with Tanks. |
| 3: Orchestrator | ✅ Done 2026-11-12: Tanks on demand (Neko via docker-socket-proxy), UDP port pool 59000–59009, separate Tank origin (`tanks.<domain>`) with Caddy forward_auth (60s signed ticket → per-Tank pass cookie; membership re-checked per request), direct + `TANK-` code invites (codes also work for sign-up), viewer tracking over WebSocket, idle (15m) / lifetime (8h) reaper, Docker reconcile, egress firewall (`egress/`: Tanks reach the internet + allowlisted LAN media servers only). Phase 0 spike stopped. |
| 3 fixes | ✅ Neko WebSocket through forward_auth (strip Upgrade headers), prefixed healthcheck, NAT1TO1 resolved to a single IPv4, Windows Firewall rule for UDP 59000–59009. Video verified working on LAN. |
| 4: Hardening | ✅ Done 2026-11-13: TOTP 2FA (RFC 6238, replay-protected, 8 single-use recovery codes, QR enrollment at /account), password change (signs out other sessions), host can remove guests (membership + Neko session disconnected via per-Tank API token), nightly SQLite backups to `./backups` (keep 14), CSP + security headers from the app. coturn deferred until a friend actually needs it. |
| 5: Polish | ✅ Done 2026-11-13: Tank start page + bookmarks bar (written into each container before Firefox starts; tiles from `TANK_START_TILES`), admin dashboard at /admin (live Tanks with CPU/memory, close any; accounts with online/2FA/last seen, disable = sign out + drain hosted Tanks + remove from others), room page fills the window with a collapsible side panel. Pre-warmed Tank skipped: start takes ~3s and a warm spare would hold a 6-CPU container idle. |
| Friends' Tanks | ✅ Added 2026-11-15: the home page lists live Tanks hosted by your friends ("Friends' Tanks"), with one-click Join. Per-Tank host switch `friends_can_join` (default on, migration 6). Blocking removes the friendship, so blocked users never see them. Live refresh via the `friends.tanks` WebSocket event. |
| Tank previews | ✅ Added 2026-11-15: Tank tiles on the home page show a small screenshot, taken through Neko's API (`/api/room/screen/shot.jpg`, per-Tank API token) about 30s after opening and then every `TANK_PREVIEW_MINUTES` (default 10, 0 = off). Kept in memory only and dropped when the Tank closes. Served at `/api/tanks/:id/preview` to members and to friends who can see the Tank. |
| Link previews | ✅ Added 2026-11-15: `/join/<TANK code>` invite links unfurl in Discord etc. The app serves `index.html` with Open Graph tags (Tank name, host, viewers) and `og:image` = `/api/tank-codes/<code>/preview.jpg`, public to anyone holding a valid code (they can already join). Captures a screenshot on demand if the Tank has none yet. Invalid/expired codes get generic tags. `/t/<id>` links stay member-only, no preview. |
| Revoking invite links | ✅ Added 2026-11-15: the host's Invite panel lists working `TANK-` links (last 4 characters, uses) with **Revoke**. Revoking stops joining, sign-up and link previews at once; people who already joined stay. `code_hint` column (migration 7) keeps the last 4 characters, since codes are stored hashed. |
| "In a Tank" status | ✅ Added 2026-11-15: the friends list shows when a friend is watching a Tank. It names the Tank (with a Join button) only if you could see it yourself: you're a member, or it's open to you as a friend of its host. Otherwise it just says "In a Tank". Live via the `friends.activity` WebSocket event, sent to the watcher's friends when they start or stop watching, are removed, or the Tank closes. |
| Guests | ✅ Added 2026-11-15: `TANK-` links no longer create accounts; non-users join as temporary watch-only guests (see §3). `FISH-` sign-up codes stay with members (home page); the Admin page shows everyone's codes, an invite log, and "Invited by" (migration 8). **Neko now uses one login per person** (`NEKO_MEMBER_PROVIDER=file`, logins created through Neko's API with per-person permissions: host = Neko admin, accounts can be handed control, guests can't; passwords derived per Tank+user, never stored). Removing someone deletes their Neko login, which ends their stream. Tanks started before this keep the old shared passwords until drained. |
| Avatars in Neko | ✅ Added 2026-11-15: each person's Neko profile carries their FishTank avatar, so it shows in Neko's member list at the bottom of the Tank. Neko only accepts http(s) image URLs and its page is on the Tank origin, so the link is signed (`/api/avatars/<id>?v=…&sig=…`, HMAC, works without a login, only for that user's current avatar). Changing or removing an avatar updates the profile in live Tanks (`POST /api/members/<username>`) and the old link stops working. Guests get Neko's generated avatar. |
| Twitch login | ✅ Fixed 2026-11-14. Twitch's login bot check rejected Tanks as "Your browser is not currently supported", in both Firefox and the Neko Chromium image. Not the cause: H.264 support, user agent, Firefox tracking protection, uBlock Origin. **Fixed by** making each Tank's Firefox look like a normal desktop: WebGL reports an NVIDIA GPU instead of the software renderer `llvmpipe` (`TANK_WEBGL_GPU`, written to the profile's `user.js`), and the browser time zone matches the home IP (`TANK_TIMEZONE`, passed as `TZ`). Not tested which of the two did it; keep both. Twitch also bypasses tracking protection + uBlock (`TANK_TRUSTED_SITES`; harmless, may not be needed). Logins don't persist: every Tank is a new device. |

**Layout:** `apps/server` (Fastify API, `src/index.ts` entry, tests in `test/`), `apps/web` (React UI), `docker-compose.yml` (app on `fishtank-edge` 10.88.1.0/24, data in volume `fishtank-data`), `spike/` (standalone Neko test room).

**Commands** (from the project root):
- Run the stack: `docker compose up -d --build`, then open http://localhost:3080
- First admin code: `docker logs fishtank-app` (printed only while no accounts exist; a new one on each restart)
- Tests: `npm test` · Typecheck: `npm run typecheck`
- Dev with hot reload: `npm run dev:server` + `npm run dev:web`, then open http://localhost:5173

## 10. Security review (2026-11-13)

Fixed:
- **Docker access**: replaced the generic socket proxy with `docker-gate/`, an allowlisting proxy. It only creates Tank containers that match a strict template (Tank image, Tank network, no privileges, no mounts, no extra capabilities, Tank UDP ports) and only acts on labelled `tank-*` containers. Exec, other containers, volumes, networks, builds and other images are refused. Verified live.
- **Stale Tank browser**: the Tank image is pulled on startup and daily, so new Tanks get Firefox security updates.
- **Login lockout**: Docker Desktop hides client IPs (everyone looks like one IP), so login limits are per username (10 per 15 minutes) plus a high global failed-login cap (300 per 5 minutes). Registration has a global cap.
- **Tank defaults**: control is locked to the host (`NEKO_SESSION_LOCKED_CONTROLS`), and drag-and-drop upload is off.

Accepted or deferred: admin 2FA stays optional (recommended); guests browse from the home IP; backups stay on the same disk (copy them off-machine manually).

## 11. Security review (2026-11-15)

Scope: keep outsiders out and limit abuse if they get in. People inside a Tank seeing logins there is an accepted risk (trusted groups).

Verified live:
- **Tank network isolation**: from the Tank IP range, only the internet and the allowlisted media servers are reachable. The app, Caddy, other Tanks, the router, LAN hosts, the Docker host, metadata and the Docker gate are all blocked. A control test from outside the Tank range confirmed it's the firewall doing it. IPv6 is off on both networks.
- **Public edge**: `/auth/*` is not reachable from the internet (case, double-slash, encoded and dot variants all 404). The Tank origin returns 401 without a pass and 404 at its root.
- **Guest lockdown**: the API allowlist held against path tricks (`//`, `..`, `%2F`, trailing slash, `;`, case).
- **Dependencies**: `npm audit` clean. No raw-HTML rendering in the web app.

Fixed:
- **Tank containers** drop NET_RAW (no ARP spoofing on the bridge shared with the app and Caddy), MKNOD and AUDIT_WRITE, and have PidsLimit 2048. The Docker gate requires this, so a compromised app can't start an unhardened Tank. Verified with a real Tank.
- **Guest-join and sign-up rate limits** are per client IP, not global: an outsider spamming bad codes can no longer block everyone else's guests.
- **Logs** no longer contain `TANK-`/`FISH-` codes from request URLs.
- **APP_ORIGIN** is the public origin only (`http://localhost:3080` removed). The local test port still serves pages, but signing in or changing anything there is refused; use the public URL.

Open (recommended):
- **Don't attach other services to `fishtank-tanks`.** The egress firewall only filters traffic *from* Tanks, so an internet-facing service on that network (e.g. a media server), if compromised, reaches the app and every Tank's Neko on port 8080 directly (Neko still needs a per-person password). Reach such services by LAN IP through `TANK_ALLOW_DESTINATIONS` instead.
- **Require 2FA for admins**: an admin account can disable users, close Tanks and read the invite log.
- **Backups** hold password hashes, TOTP secrets and the app's signing keys, unencrypted on the same disk. Copy them somewhere safe and keep `./backups` private.
- Accepted: members can mint up to 5 sign-up codes (a stolen member account can invite more people, which the invite log shows); Tank links posted publicly let up to their use count of strangers watch as guests; (fixed since: Neko passwords are no longer in any URL, see below).
- **Neko passwords out of URLs** (2026-11-15): the Tank iframe URL carries only a single-use 60s ticket. On the first Tank-origin request the app signs the person in to Neko from the server (`POST /api/login`) and sets Neko's session cookie (`NEKO_SESSION`, `NEKO_SESSION_COOKIE_ENABLED=true`) scoped to `/<tankId>/` alongside the pass cookie, so the password never reaches the browser. A reused ticket is refused unless the browser already holds a valid pass. Verified on a real Tank: the cookie authenticates Neko's WebSocket, and still wins over a stale saved token. Tanks started before this fall back to credentials in the Tank-origin redirect only, which Neko's page reads and then strips.
