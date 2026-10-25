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

## Support Cascade

Made with ❤️ in India. If Cascade's useful to you, voluntary support is welcome but never required — it's free either way.

All the values below (GitHub username, UPI ID) live in one place: [`maintainer.config.json`](maintainer.config.json). This README and `.github/FUNDING.yml` are both static text GitHub renders directly — nothing on GitHub's end can read the config live the way the in-app Support button does — so a GitHub Action picks up any change to that file on push and commits the synced result here automatically; nothing further to do after pushing the config change itself. To preview the result locally first, run `npm run sync:maintainer`.

- **From anywhere**: <!-- MAINTAINER:SPONSORS_LINK_START -->
[GitHub Sponsors](https://github.com/sponsors/Syncxy)
<!-- MAINTAINER:SPONSORS_LINK_END --> — pick $1, $5, $10, or a custom amount, one-time or recurring. GitHub pays out straight to an individual's own bank account; no company needed on either end, and GitHub takes no cut on personal sponsorships (payment-processor fees may still apply).

  The "Sponsor" button doesn't appear on its own — two things both have to be true first: `.github/FUNDING.yml` has your *real* GitHub username in it, **and** that account has a live GitHub Sponsors profile. The file alone does nothing until the profile behind it exists. To set one up: go to [github.com/sponsors](https://github.com/sponsors), start a sponsored developer profile, and complete the bank details and agreement — GitHub reviews it before it goes live, which can take a few days.

- **From India**: UPI, directly to the maintainer's own bank account. Zero fees, settles instantly, no intermediary.

<!-- MAINTAINER:UPI_START -->
  Not set up yet. `upiId` is empty in `maintainer.config.json` — add it there and re-run `npm run sync:maintainer` to show a real UPI ID and QR here instead of this line.
<!-- MAINTAINER:UPI_END -->

  Worth knowing if a UPI ID feels too exposing to put in a public README: it doesn't have to be your phone number. Most bank apps let you set a custom UPI ID (like `yourname@oksbi`) that's unrelated to your number, under the app's "manage UPI ID" or "add new UPI ID" screen — worth checking before ruling UPI out.

A couple of things worth knowing, honestly:
- These links are plain, static URLs/files in this repo — the same as any other file. Nothing stops someone who forks the project from pointing their own copy's links at their own accounts; that's true of every open-source donate button, not specific to this setup. The only real protection is the normal one: review PRs before merging, and keep the canonical links here, in this README and in `.github/FUNDING.yml`, as the one place people should trust.
- Receiving money, including gifts/donations, can carry tax and reporting obligations in India (and wherever a supporter sends from). This isn't tax or legal advice — if it starts adding up to real money, it's worth a quick conversation with a chartered accountant.

## Contributing

Bug reports, feature requests and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) to get set up. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Found a security issue? See [SECURITY.md](SECURITY.md) rather than opening a public issue. Released changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

Cascade is licensed under the **PolyForm Noncommercial License 1.0.0**.

You are welcome to use, study, modify, share, and contribute to Cascade for noncommercial purposes.

Commercial use, including selling Cascade or modified versions, requires separate permission from the copyright holder.

See the [LICENSE](LICENSE) file for the complete terms.

Copyright © 2026 Cascade contributors. All rights reserved except as expressly licensed.
