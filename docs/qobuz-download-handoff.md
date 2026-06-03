# Qobuz In-Plugin Download — Build Handoff (for Codex)

> Hand this whole file to Codex. It contains every verified fact, the current
> blocker, and the full implementation plan + code-level details so you can
> build the feature end-to-end with minimal back-and-forth.
> **Personal-use only** (the user's own Qobuz subscription). Not for distribution.

## Goal

Add to the **Volumio `ai_autopilot` plugin** the ability to:
1. Download a Qobuz track to local disk (button next to each track), and/or
   **download-then-play** it as a **local file** (so playback has zero streaming/buffering).
2. **Prefetch** the next N queued tracks in the background.
3. **Batch/album** download (several tracks at once) and a "quiet mode" (local
   playback + pause the plugin's own background work).
   (System/CPU tuning is a *later* phase — out of scope here.)

The unifying mechanism (all confirmed on-device):
```
qobuz track id  ──resolve──▶ signed FLAC stream URL
   ──download──▶ /mnt/INTERNAL/qobuz-tap/<id>.flac
   ──mpc update──▶ MPD indexes it
   ──replaceAndPlay {service:"mpd", uri:"music-library/INTERNAL/qobuz-tap/<id>.flac"}──▶ local playback
```

## Repo / branch / what already exists

- Repo: `samadi81/volumio-ai-autopilot` (public). Node.js Volumio `music_service` plugin.
- **Work on branch `claude/gemini-llm-issues-2ATXy`** (draft PR #9). Do **NOT** merge
  to `main` until the whole feature is verified live on-device (the plugin's
  "update" button pulls `main`).
- Device plugin dir: `/data/plugins/music_service/ai_autopilot`. Volumio user has
  passwordless sudo. Plugin runs inside the Volumio Node backend.
- Already implemented on the branch (you will wire them together):
  - **`lib/qobuz.js`** — `QobuzClient` (`login`, `getFileUrl`, `downloadTrack`),
    `fetchAppConfig()` (app_id/secret "spoofer"), `pickSecret()`, `init()`,
    `FORMAT` codes (5/6/7/27). Uses `node-fetch` + `crypto`.
    **getFileUrl signing (verified scheme):**
    `request_sig = md5("trackgetFileUrlformat_id"+fmt+"intentstreamtrack_id"+id+ts+secret)`
  - **`lib/track-cache.js`** — `TrackCache`: download URL→file, `mpc update`+wait,
    `/mnt/...`→`music-library/...` uri mapping, `playLocal()` via `replaceAndPlay`.
    The `trackId → stream URL` step is **injected** as `resolveStreamUrl`.

## Phase 0 spike — verified facts (don't re-discover)

**Storage / MPD**
- No USB attached. Use `/mnt/INTERNAL/qobuz-tap` (overlay fs, ~9.1G free). If a
  USB is later mounted under `/mnt/USB/...`, prefer it.
- MPD `music_directory = /var/lib/mpd/music`; symlinks `INTERNAL -> /mnt/INTERNAL`,
  `USB -> /mnt/USB`. So an absolute file `/mnt/INTERNAL/qobuz-tap/x.flac` is:
  - mpc path: `INTERNAL/qobuz-tap/x.flac`
  - Volumio library uri: `music-library/INTERNAL/qobuz-tap/x.flac`

**Local-file playback (CONFIRMED)**
```bash
# 1) file lands in /mnt/INTERNAL/qobuz-tap/x.flac
mpc update INTERNAL/qobuz-tap        # async — wait until file appears in `mpc listall`
# 2) play via Volumio REST:
curl -s -X POST http://localhost:3000/api/v1/replaceAndPlay \
  -H 'Content-Type: application/json' \
  -d '{"item":{"uri":"music-library/INTERNAL/qobuz-tap/x.flac","service":"mpd"}}'
# -> {"response":"success"}; getState shows service "mpd", local uri, trackType flac
```

**Queue track ids**
- `GET http://localhost:3000/api/v1/getQueue` → items with `uri: "qobuz://song/<id>"`.
  The numeric `<id>` is the Qobuz track id.

**MyVolumio Qobuz is closed (do NOT depend on it)**
- `/myvolumio/plugins/music_service/qobuz/index.js` runs an **encrypted** `lib/qobuz.node`.
- Track resolution goes through MyVolumio cloud `prod.vlmapi.io/v2/qobuz/explodeUri`.
- `streaming_services.getStreamUrl(uri)` posts to `daemonUrl(127.0.0.1:7777)/streamurl`,
  but **`volumio-streaming-daemon.service` does not exist on this device and 7777
  is not listening** → no usable internal/REST path to resolve a stream URL silently.
- `POST /api/v1/explodeUri` → 404. No `pluginEndpoint` exposes getStreamUrl.

## CURRENT BLOCKER — Qobuz official-API login returns 401

The chosen resolver is the **qobuz-dl / streamrip approach**: talk to Qobuz's own
API directly with the user's credentials (independent of MyVolumio).

What's verified:
- Spoofer works: `fetchAppConfig()` returns a valid `app_id` + 3 secret candidates.
- The app_id reaches Qobuz (signature checks return "Invalid Request Signature"
  for wrong secrets → app_id accepted).
- The account is **valid**: the user can log into `qobuz.com` in a browser with
  the same email/password.

What fails:
- `POST/GET user/login` returns **401 `"User authentication is required."`** for
  **all four** combinations (GET/POST × md5(password)/plaintext), with a browser
  User-Agent and `X-App-Id` header set. So it is **not** password format or HTTP
  method.

### Your first job: fix the login, definitively

The reliable way is to **replicate exactly what a currently-working client does**.
Two complementary approaches — do both as needed:

1. **Read the current `streamrip` `dev` source** (actively maintained; the user's
   other handoff pins streamrip dev) and replicate its Qobuz login precisely:
   - `https://github.com/nathom/streamrip` → `streamrip/client/qobuz.py`
     (login flow, exact headers, params, request signing, and how it derives the
     valid secret). Match it byte-for-byte in `lib/qobuz.js`.
   - Also cross-check `qobuz-dl` `qobuz_dl/qopy.py`.
2. **Capture the real browser login request** (privacy-safe): on `play.qobuz.com`
   open DevTools → Network → log in → inspect the `user/login` request. Compare
   method, URL, **all request headers** (esp. any `X-App-Id`, `X-User-Auth-Token`,
   `Origin`, `Referer`, and any other `X-...`), and the payload **field names**
   (`email` vs `username`, extra fields). Make `lib/qobuz.js` send the same.
   - Likely suspects to test: a required `Origin`/`Referer: https://play.qobuz.com`,
     a specific User-Agent, a `username` field, or that login must NOT be signed
     while another header is required.

Credentials handling: the user's Qobuz email/password are entered **on the device
in plugin settings** (or via env for a standalone test). **Never log, print, or
commit credentials, tokens, or signed URLs.**

A standalone Mac test harness already exists at `~/qobuz-test/` (`qobuz.js` is
fetched from the branch raw URL, `diag.js` tries login variants). Use it to iterate
on login without touching the device:
```
curl -s -o qobuz.js https://raw.githubusercontent.com/samadi81/volumio-ai-autopilot/claude/gemini-llm-issues-2ATXy/lib/qobuz.js
# set QOBUZ_EMAIL / QOBUZ_PASSWORD in env (zsh: read "QE?..."; read -s "QP?..."), then: node <test>
```

### Fallback resolver (only if official login truly can't be made to work)
"Play-to-resolve": `replaceAndPlay(qobuz://song/<id>)`, then read MPD's current
file URL (`mpc -f "%file%" current`) — that IS the signed FLAC URL (verified: 206,
`fLaC`, `audio/flac`). Download it, then restore the previous playback state
(save queue+index+seek first). This **interrupts playback**, so it's acceptable
only for "download the currently-playing track", not for silent prefetch. Treat
as last resort.

## Phase 1 — implementation plan (code-level)

Follow the plugin's existing conventions (prototype methods on `AiAutopilot`,
`self.config.get/set`, libQ promises, `commandRouter.pushToastMessage`,
remote panel in `lib/http-api.js`). Verify each step before the next.

### 1. Config (`config.json` + `UIConfig.json`)
Add (mirror existing field/save-list patterns; remote panel reads these dynamically):
- `download_enabled` (boolean, default false)
- `download_dir` (string, default `/mnt/INTERNAL/qobuz-tap`)
- `download_quality` (number/select, Qobuz format_id; default `7` = 24-bit ≤96k;
  options 5/6/7/27)
- `qobuz_email` (string), `qobuz_password` (password input)
- `prefetch_count` (number, default 0 = off; e.g. 1–3)

### 2. Plugin wiring (`index.js`)
- Instantiate on `onStart`: a `TrackCache({ dir: download_dir, resolveStreamUrl, logger })`.
- Lazy Qobuz client: build a single `QobuzClient`, call `init({email,password,testTrackId})`
  on first use (cache app_id/secret/token; re-init on auth errors). `testTrackId`
  can be a current queue id.
- `resolveStreamUrl = async (trackId) => (await client.getFileUrl(trackId, download_quality)).url`
- Methods:
  - `downloadTrack(trackId)` → `tc.download(trackId, {ext})` → returns `{libraryUri}`,
    update a job map `{trackId: {state:'downloading'|'done'|'error', progress, libraryUri}}`.
  - `downloadAndPlay(trackId)` → download then `tc.playLocal(libraryUri)`.
  - `prefetchUpcoming()` → read `/api/v1/getQueue`, download next `prefetch_count`
    qobuz tracks not already cached (only if `download_enabled`). Hook into the
    existing `QueueMonitor` tick (throttled).
- Extend `getQuickState()` to include per-queue-item download status
  (`cached`/`downloading`(progress)/none) so the remote panel can render it.

### 3. Remote panel (`lib/http-api.js`)
- Per queue row: a **⬇️ download** button (and a small progress indicator). If the
  track is already cached, show a "play local" affordance. (Tapping the row already
  plays via `playIdx`; keep download as a separate small button with
  `event.stopPropagation()`.)
- New routes: `GET /download?id=<trackId>`, `GET /download-play?id=<trackId>`;
  surface progress through the existing `/state` poll (don't add a tight new poll).
- Respect the existing dropdown-safe poll guards.

### 4. Prefetch / batch / quiet mode
- Prefetch: when `download_enabled` and `prefetch_count>0`, after each track change
  download the upcoming N qobuz tracks (skip already-cached).
- Batch: a "download these N" action (e.g., current queue window or an album's tracks).
- Quiet mode: while playing from local cache, pause the plugin's own monitor/AI
  triggers to minimize background activity.

### 5. Cache hygiene
- SD-only (~9.1G): cap cache size / count; prune oldest when over budget. Make the
  cap configurable. Prefer USB if mounted.

## Gotchas (learned the hard way)
- `mpc update` is **async** — wait until the file appears in `mpc listall` before
  `replaceAndPlay` (already handled in `track-cache._indexAndWait`).
- Use **id-based filenames** (`<id>.flac`, no spaces/special chars) for robust mpc
  paths + `music-library` URIs. Metadata comes from the FLAC's embedded tags.
- Qobuz `format_id 27` (24/192) may not exist for every track/subscription;
  `getFileUrl` returns the actual delivered format — surface it.
- Qobuz private API is fragile: app_id/secret scrape can break on web-player
  updates; keep a manual `appId`/`secret` override path (already supported in
  `init({appId, secret})`).
- **Never** log/commit credentials, tokens, or signed stream URLs.
- Keep all streamrip/qobuz API knowledge inside `lib/qobuz.js` only.

## Definition of done (verify on-device before merging to main)
1. Standalone: `qobuz.js` logs in, `getFileUrl` returns a URL, sample download is `fLaC`.
2. On device: pressing ⬇️ downloads a real queued track to `/mnt/INTERNAL/qobuz-tap`,
   MPD indexes it, and it plays as a **local** file (getState: service `mpd`, local uri).
3. Prefetch downloads the next track silently (no playback interruption).
4. Remote panel shows download button + progress + cached state correctly.
5. Then (and only then) open/merge the PR to `main`.
