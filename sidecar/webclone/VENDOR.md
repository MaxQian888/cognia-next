# Vendored: web-clone

This directory vendors the **web-clone** single-execution web-page snapshot engine
(HTML + CSS/JS/image/font mirroring → self-contained single file or directory
bundle; optional component extraction + Vue/React/Angular/Svelte/jQuery codegen).

- **Upstream:** https://github.com/kkkqkx123/web-clone
- **License:** MIT (see upstream)
- **Vendored at:** 2026-07-12

## Why vendored into the sidecar

The engine is a Node program: it imports `node:http`/`node:fs`, `http-proxy-agent`,
`linkedom`, and `@babel/*`. It cannot run in cognia's static-export renderer
bundle. The sidecar is cognia's home for heavy Node work and keeps these deps in
its own lockfile, off the app bundle. It is excluded from the Jest coverage gate
and tested with `node --test` (see `sidecar/webclone/tests/`).

## Changes from upstream (kept minimal & surgical)

1. **Dropped the CLI + Playwright surface.** Removed `src/cli.ts`,
   `src/config/cli-adapter.ts`, `src/adapters/playwright-fetcher-adapter.ts`,
   `src/adapters/index.ts`, `src/types/playwright.d.ts`. `snapshotWithPlaywright`
   / `snapshotWithBrowserContext` were removed from `assembler.ts` and `index.ts`
   (the sidecar has no Playwright dependency). The HTTP `snapshot()` and
   `convertLocalSnapshot()` APIs are unchanged.
2. **Added an SSRF guard** (`src/ssrf-guard.ts`, a faithful port of the app-side
   `lib/web/fetch-guard.ts`). Every outbound URL — entry page, every
   sub-resource, and every redirect target — is funnelled through
   `guardOutboundUrl` at the single choke point in `src/fetcher.ts`
   (`fetchWithTimeout`). A new `allowPrivateHosts` option (default `false`) opts
   into private/loopback targets, mirroring the app.
3. **Added a process-isolation runner** (`src/runner.ts`). The sidecar spawns
   `dist/runner.js` as a short child process; it reroutes the library's
   `process.stdout` progress chatter to stderr and emits exactly one JSON result
   envelope on stdout, so it never corrupts the sidecar's JSON-RPC channel.

The vendored library files are otherwise unmodified upstream source.
