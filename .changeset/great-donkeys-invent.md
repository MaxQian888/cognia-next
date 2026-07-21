---
"cognia-next": minor
---

Require Node.js 26. The whole toolchain moves off Node 20: `engines.node` is now
`>=26.0.0` across the app, CLI, sidecar and every `@cognia/*` package, CI and the
server/runner images build on Node 26, the packaged CLI binary is built from
node26 pkg base binaries, and the chat sidecar's runtime probe rejects anything
older. `better-sqlite3` moves to 13.x, which ships N-API prebuilds — the
code-graph SQLite backend no longer breaks on a Node major bump.
