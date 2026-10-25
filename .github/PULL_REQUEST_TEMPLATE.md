## What this changes


## Why


## How it was tested
Which tests were added or run, and — for anything touching the download engine, the bridge, or persistence — what you actually did to verify it (e.g. "killed the app mid-download at several points and confirmed it resumed correctly"), not just "added a unit test."

## Checklist
- [ ] `npm test` passes, run more than once (timing-sensitive engine behavior can be intermittent)
- [ ] `src/renderer/renderer.ts` still has no `import`/`export` statements, if touched
- [ ] Docs updated if behavior visible to users changed (README, CHANGELOG)
