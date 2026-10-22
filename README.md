# Cascade

A fast, persistent download manager for macOS: multi-connection downloads with dynamic work-stealing,
torrent-style pause/resume that survives restarts and crashes, and a Chrome extension that catches
downloads at the click of a button. "Cascade" is a working title.

## Run it

```bash
npm install
npm run dev          # builds, then launches the app
npm test             # 58 automated tests
npm run dist:mac     # unsigned .dmg/.zip via electron-builder
```

Your existing v0.1 downloads in progress are migrated automatically (their partial data moves to a `.part` file).

## Chrome extension (catch downloads from the browser)

1. In Cascade: **Settings → Browser integration** → *Show extension folder*. Copy the pairing token.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose that `extension` folder.
3. The extension's settings page opens: paste the token → **Test connection**.

Now when a download starts in Chrome, Cascade takes it over (cookies, Referer and User-Agent are forwarded so
logged-in downloads work). You can also right-click any link → **Download with Cascade**. Works in Chromium
browsers (Edge, Brave, Arc).

- Cascade only lets go of Chrome's copy after the server has accepted *its* request. If the app isn't running, the
  token is wrong, or the server refuses a re-fetch (e.g. a POST-only link), Chrome just downloads normally.
- Not captured: `blob:`/`data:` downloads, incognito windows, and anything on your "never capture" list.
- The extension asks for "all sites" access because it needs per-site cookies for authenticated downloads and to
  reach `127.0.0.1`. It never reads page content.
- Security: the bridge listens on `127.0.0.1` only, rejects web-page origins and DNS-rebinding hosts, and
  requires the pairing token.
- **Status: tested against the real bridge with a mocked `chrome` API, but not yet in a real Chrome.** Please test it
  on a site with a "Download" button and tell me what you see.

## Speed

Each download is split into up to 16 connections (configurable 1–32). When a connection finishes, it steals the
back half of the slowest remaining one, so one bad connection can't hold up the tail. Redirects are resolved once;
network chunks are coalesced into 1 MiB writes; requests ask for raw bytes (`Accept-Encoding: identity`).

Measured on a simulated server (per-connection throttling), old engine vs new:

| Scenario | Old | New |
|---|---|---|
| Server caps every connection at 3 MB/s (24 MiB file) | 1.00 s (8 conns) | 0.53 s (16 conns) |
| One connection in four crawls (32 MiB file) | 15.8 s (8 conns) / 7.8 s (16) | 1.56 s |

Be realistic about it: multi-connection helps when a server limits each connection or connections are uneven.
It cannot beat your line speed, and on an already-fast, unthrottled server a single connection can be as fast or
faster for small files (about 0.4 s of connection setup, seen in testing). Some servers dislike many connections;
lower the setting in that case.

## Pause/resume that persists

- Unfinished data lives in `name.ext.part`; resume data lives next to it in `name.ext.part.json`. The real file
  name only appears when the download completes, so a half-finished file never looks finished.
- The queue (`queue.json`) is written atomically with fsync, with a backup copy; progress is saved at least every
  5 s, and received bytes are forced to disk before progress that claims them is recorded.
- On launch, Cascade restores the queue, falls back to the backup, and finally scans download folders for
  `.part.json` files. A lost or corrupt queue file cannot lose a download.
- Downloads that were running when the app closed resume automatically; ones you paused stay paused.
- Quitting, shutting down and restarting save everything first (Electron's shutdown/sleep hooks); after sleep,
  connections are re-established. Transient failures (network drop, 5xx) retry automatically with backoff.
- If the file changes on the server between pause and resume (validated with `If-Range`), the partial data is
  discarded and the download restarts instead of mixing old and new bytes.
- Verified by killing the real app process: paused → killed → still paused with identical progress; killed
  mid-download → resumes from within about a second of where it died; queue file deleted → recovered from the
  `.part.json` beside the partial file.

Limits that no download manager can fix: a server that doesn't support Range can't be resumed (the row shows
"Can't resume"); a signed link that has expired needs a fresh link.

Diagnostics: **Settings → Storage → Show** opens the data folder (`queue.json`, `settings.json`, `cascade.log`).

## File names and types

Names come from the server's `Content-Disposition`, then the URL; a missing or script-like extension
(`.php`, none) is fixed from `Content-Type`; if that says nothing, the file's first bytes are inspected. So an image
link like `https://cdn.example/photo-1234?w=800` saves as `photo-1234.jpg`, not an extensionless blob. If a link
that claims to be an image answers with an HTML page (login wall, hotlink protection), the download fails with an
explanation instead of saving a web page under an image's name. Existing files are never overwritten.

## Settings

System/Light/Dark plus six themes (Cascade, Ocean, Forest, Sunset, Rose, Graphite), with checked text contrast.
Your download folder is remembered: pick it once (in *Add Download* or Settings) and it's used from then on,
including for browser-captured downloads.

## Layout

```
src/engine/    Pure Node download engine: DownloadTask, DownloadManager, SegmentDownloader, naming, sidecar files
src/main/      Electron main: settings, browser bridge, shutdown/sleep handling, IPC
src/renderer/  Plain TS/HTML/CSS UI (no bundler)
extension/     Chrome extension (Manifest V3); core.js holds the logic and is unit-tested
tests/         Engine, settings, bridge-security and extension-flow tests against local servers
```

## Not done yet / caveats

- Not verified on an actual Mac (built and tested on Linux, including real-process kill/restart tests).
- Unsigned builds trigger a Gatekeeper warning; signing/notarization needs an Apple Developer ID.
- Downloads don't get the macOS quarantine flag yet, so Gatekeeper won't check downloaded apps like it does for browser downloads.
- No app icon for the desktop app yet (the extension has one).
