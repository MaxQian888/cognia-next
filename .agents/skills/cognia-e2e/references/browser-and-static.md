# Browser and static-export E2E

## Scope

Use the `chromium` project for desktop web-mode UI, client persistence, static-export routes, deterministic request contracts, and product journeys that do not require Capacitor or Tauri IPC.

Read before editing:

- `tests/e2e/README.md`
- `playwright.config.ts`
- `tests/e2e/global-setup.ts`
- `tests/e2e/helpers/db-reset.ts`
- the closest live spec and relevant mock
- `.github/workflows/test.yml` E2E build/run/report jobs

## Harness

- `NEXT_PUBLIC_E2E=1` is a **build-time** switch that includes `ExposeTestGlobals` and its `window.__cognia*` bridges.
- `resetCogniaDb(page)` establishes an unlocked test account when AccountGate blocks the app, waits for the bridge, and resets the active DB.
- Use `setCogniaSettings`, `readDexieRow`, and other existing exports from `tests/e2e/helpers/db-reset.ts`; do not dynamic-import `@/` modules inside `page.evaluate`.
- The global setup starts shared V2, Anthropic, GitHub, Lark, and vector DB mocks. A spec may start its own instance only when it needs isolated mutable scenario control.
- Every Playwright test receives a fresh browser context, but the app may still need explicit database reset and settings seed.

## Commands

```bash
rtk pnpm exec playwright test --list --project=chromium tests/e2e/<area>/<target>.spec.ts
rtk pnpm exec playwright test --project=chromium tests/e2e/<area>/<target>.spec.ts --workers=1
rtk pnpm test:e2e:build
rtk env PLAYWRIGHT_STATIC=1 pnpm exec playwright test \
  --project=chromium tests/e2e/<area>/<target>.spec.ts --workers=1
rtk pnpm audit:e2e-governance
```

Use `PLAYWRIGHT_NO_SERVER=1` only when an appropriate server is already running. If running `pnpm dev` yourself, start it with `NEXT_PUBLIC_E2E=1`.

## Static-export integrity

A focused static run against an old `out/` is invalid evidence. Rebuild after relevant source/helper changes. `scripts/e2e/serve-out.mjs` verifies that an E2E bridge exists, not that the export matches the current source.

CI builds one E2E export, runs `chromium` and `mobile-pixel-7` in shards with `PLAYWRIGHT_STATIC=1`, retains blob reports, and merges HTML/JSON reports. Reproduce the narrow target first, then the matching CI shape.

## Diagnostics

On failure retain:

- first failing trace, screenshot, and video;
- browser console and page errors;
- mock request/response or control-state evidence;
- persisted row when persistence is the contract;
- exact build/run commands and whether the server was dev or static.

Do not treat a dev-server pass as proof of static-export behavior when the change can be affected by export, build-time flags, routing, or hydration.
