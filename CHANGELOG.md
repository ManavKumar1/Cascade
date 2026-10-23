# Changelog

All notable changes to Cascade are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/) once the engine's interfaces settle — for now, the minor version moves with each meaningful round of changes.

## [0.3.0] — 2026-10-23 — first public release

### Added
- Richer download list: a file-type icon per row, a copy-download-link action, a distinct "Retry" action for failed downloads (previously reused the "Resume" control), and action buttons that are visible at rest instead of hidden until hover.
- The progress bar now reflects the engine's actual live connection count as visible channel seams, with a flowing highlight while a download is active.
- Short, deliberate motion: new rows animate in, reordering animates between positions (both skipped automatically when the OS-level "reduce motion" setting is on), and buttons give brief press feedback.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and this changelog.
- Licensed under PolyForm Noncommercial 1.0.0 — see [License](README.md#license).

### Fixed
- **Pause/resume race that could fail a download and lose its progress.** Calling `resume()` before an in-flight `pause()` had fully finished unwinding (flushed buffers, closed its file handle) could start a second download run against the same file handle; whichever one's cleanup ran last would close the handle the other was still writing to, failing the download outright. This was more likely on larger files with more connections, since pausing takes longer to unwind when more data is buffered — consistent with reports that large, many-connection downloads hit it reliably while small ones rarely did. Fixed with a proper per-download operation lock so pause/resume/cancel can never overlap. Verified with a fuzz test that fires resume() with zero delay after pause() across dozens of trials.
- **Crash/forced-restart could lose more progress than necessary.** Pausing, finishing, or failing a download now saves its state immediately instead of waiting for the usual debounced save, and the periodic save interval for active downloads was tightened from 5s to 2s. Verified by killing the real app process at several points during a live download; every trial recovered and finished byte-identical to the source.
- A multi-hour download using work-stealing across many connections could accumulate an unbounded number of segment records, slowing every save; this is now capped.
- Six-theme contrast: a shade of green used as status text failed WCAG contrast on light backgrounds in all six themes; fixed with a dedicated darker text variant, audited across all theme/mode combinations.

## [0.2.0] — 2026-10-22

### Fixed
- **Downloaded images saved without an image extension (or any extension).** File names came only from the URL path, so an image link like `.../photo-1234?w=800` saved as an extensionless file. Names now come from the server's `Content-Disposition` header, then the URL, with a missing or script-like extension (`.php`, none) filled in from `Content-Type`, and — if the server says nothing useful — from the file's own first bytes.
- A link that claims to be a file but returns an HTML page (a login wall or hotlink protection) now fails with an explanation instead of silently saving the web page under the expected file's name.
- **Paused downloads could come back as running after an app restart**, and progress wasn't saved often enough to survive a crash with more than a few seconds of data loss.
- Unfinished data now lives in a `.part` file next to the destination, with its resume state in a small sidecar file beside it; the real file only appears on completion, so a half-finished download never looks complete in Finder.
- The queue is written atomically with a backup copy, and startup now also scans download folders for orphaned resume data, so a lost or corrupted queue file can't lose a download.
- Transient failures (dropped connection, 5xx) now retry automatically with backoff instead of requiring a manual retry.
- Existing files are never overwritten by a new download of the same name.
- Removing a completed download from the list no longer deletes the underlying file.

### Added
- Six themes (Cascade, Ocean, Forest, Sunset, Rose, Graphite) × System/Light/Dark.
- The download folder is remembered after it's chosen once, including for browser-captured downloads.

## [0.1.0] — 2026-10-22 — initial build

### Added
- Multi-connection download engine with dynamic work-stealing: an idle connection takes over the slower half of the busiest remaining one, instead of sitting idle while one connection lags.
- Pause, resume, and cancel, backed by a persisted queue.
- Chrome extension (Manifest V3) that captures browser downloads via a local, token-authenticated bridge (loopback-only, DNS-rebinding and origin checks), forwarding cookies and headers so logged-in downloads work. Falls back to Chrome's own download if the app can't take it.
- Right-click "Download with Cascade" on links.
- Initial settings UI, test suite (engine, settings, bridge security, extension flow) against real local HTTP servers.

[0.3.0]: #
[0.2.0]: #
[0.1.0]: #
