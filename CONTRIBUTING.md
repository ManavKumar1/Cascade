# Contributing to Cascade

Thanks for taking a look. Cascade is young — the project layout and these docs will keep changing as it grows. This guide covers the basics; if something's missing, open an issue and ask.

By participating, you're expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the project's [license](README.md#license).

## Getting set up

```bash
git clone <this repository>
cd cascade
npm install
npm run dev      # builds, then launches the app
npm test         # the full test suite (engine, settings, bridge security, extension flows)
```

No bundler is involved — `npm run build` is just `tsc` plus copying the renderer's HTML/CSS alongside the compiled JS. `npm run dev` builds and launches Electron in one step.

To try the Chrome extension locally: open `chrome://extensions`, enable Developer Mode, **Load unpacked**, and select the `extension/` folder. Point it at the app using the pairing token from Settings → Browser integration.

## Project layout

```
src/engine/    Pure Node download engine — no Electron dependency, the easiest place to add tests
src/main/      Electron main process: settings, the browser bridge, window/IPC wiring
src/renderer/  The UI (plain TypeScript, HTML, CSS — no framework, no bundler)
extension/     The Chrome extension (Manifest V3); extension/core.js is unit-tested from Node
tests/         Everything runs against real local HTTP servers (see tests/testServer.ts), not mocks
```

See the [README](README.md#layout) for more on how the pieces fit together.

## Before you open a PR

- **Add tests.** `src/engine` is pure Node and has no Electron dependency, so most behavior — new engine features, bridge security rules, settings validation — can and should be tested directly against `tests/testServer.ts` rather than through the full Electron app. Look at `tests/engine.test.ts` and `tests/app.test.ts` for the existing style: spin up a local server with the behavior you need (throttling, a dropped connection, a specific header), exercise the real code against it, assert on the real result.
- **Run the full suite more than once.** `npm test` a few times in a row before pushing — timing-sensitive engine behavior (retries, work-stealing, pause/resume) is exactly the kind of thing that can pass once and fail intermittently if something's actually racy.
- **Keep `src/renderer/renderer.ts` import-free.** It loads as a plain `<script>` tag with no module loader; even a type-only `import` makes `tsc` emit CommonJS boilerplate that throws at runtime in that context. Shared types are hand-duplicated at the top of the file instead — keep them in sync with `src/shared/types.ts` if you change either.
- **Match the existing engine conventions** if you're touching `src/engine`: errors distinguish retryable from permanent (see `SegmentDownloader.ts`'s error classes), anything that touches `DownloadTask`'s file handle or status goes through its operation lock (`withOpLock`) so pause/resume/cancel can't race each other, and anything written to disk that matters for resuming after a crash should be covered by a test that actually kills a process mid-download, not just a unit test of the in-memory state (see the crash-recovery tests in `tests/engine.test.ts` for the pattern).
- **Describe what you tested**, not just what you changed, in the PR description — especially for anything touching the download engine, the bridge's security checks, or persistence. "Added X" is less useful here than "added X, verified by Y."

## Reporting bugs

Open an issue with: what you expected, what happened instead, your OS version, and — if it's about a specific download — whatever you can share about the server (does it support Range requests? is it behind a login?). For anything that looks like a security issue, see [SECURITY.md](SECURITY.md) instead of filing a public issue.

## Feature requests

Open an issue describing the problem you're trying to solve, not just the feature — it's easier to find the right design that way, and sometimes there's already a simpler path to what you need.
