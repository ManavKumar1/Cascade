# Security Policy

## Supported versions

Cascade is pre-1.0. Only the latest released version is supported with security fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Instead, email **[security contact — fill in before publishing]** or use GitHub's private vulnerability reporting (Security tab → Report a vulnerability) once the repository is public.

Include what you can: the affected version, a description of the issue, and steps to reproduce if you have them. You should get an acknowledgment within a few days. We'll credit you in the fix's release notes unless you'd rather stay anonymous.

## What's in scope

Cascade runs with filesystem access and a local network listener, so the parts most worth scrutiny are:

- **The browser bridge** (`src/main/bridge.ts`): a loopback-only HTTP server (`127.0.0.1`) the Chrome extension talks to, so it can hand a download to the app instead of Chrome's own downloader. It checks the `Host` header (DNS-rebinding protection — a malicious web page can't just point a DNS name at `127.0.0.1` and talk to it), restricts `Origin` to the extension's own `chrome-extension://` scheme, and requires a pairing token compared in constant time. If you find a way to reach it from a normal web page, from a different origin, or without the token, that's a real finding.
- **The download engine** (`src/engine/`): in particular, anything where a malicious or compromised server could get Cascade to write outside the intended destination folder, overwrite a file it shouldn't (`uniquePath` is supposed to prevent this), or execute something it downloads.
- **The settings store** (`src/main/settings.ts`): the pairing token and settings file are written with `0o600` permissions; a bug that weakens this is worth reporting.
- **The Chrome extension** (`extension/`): it requests broad host permissions (needed for per-site cookies and to reach `127.0.0.1`) but should never read or transmit page content — only download metadata and cookies for the specific download being captured.

## What's explicitly not a vulnerability report

Cascade doesn't sandbox the content of files it downloads, doesn't scan for malware, and (not yet — see the README) doesn't apply the macOS quarantine flag to downloaded files the way a browser would. Until quarantine is implemented, Gatekeeper won't challenge a downloaded app the way it would for a browser download; treat downloaded executables with the same caution you would from any download manager. This is tracked as a known gap, not something you need to separately report.
