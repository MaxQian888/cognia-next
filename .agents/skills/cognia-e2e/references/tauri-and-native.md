# Tauri and native E2E

## Scope

Use `tests/e2e/tauri/**` only for contracts that require the real Tauri shell: Rust commands, WebView2/CDP, sidecars, keyring/subscription integration, native OCR, native plugin permissions, or a connector/agent flow whose risk is specifically the IPC/native boundary.

Read:

- `playwright.config.ts`
- `tests/e2e/tauri/fixtures.ts`
- `tests/e2e/helpers/tauri-cdp-launch.ts`
- `tests/e2e/global-setup.ts`
- the closest Tauri spec
- the Windows `e2e-tauri` job in `.github/workflows/test.yml`

## Platform contract

The real Tauri Playwright project is Windows-only because it drives WebView2 through CDP. macOS WKWebView and Linux webkit2gtk do not expose that endpoint. On a non-Windows host, run static discovery and lower-level Rust/TypeScript checks, then report the real Tauri run as unverified.

`PLAYWRIGHT_TAURI=1` opts in the project and launch path. `PLAYWRIGHT_TAURI_DRIVER=1` is only a legacy alias. Do not install or assume `tauri-driver`; the current harness launches the debug binary and connects to WebView2 directly.

## Commands

```bash
rtk env PLAYWRIGHT_TAURI=1 pnpm exec playwright test --list \
  --project=tauri tests/e2e/tauri/<area>/<target>.spec.ts

# Windows, after prerequisites:
rtk pnpm tauri build --debug --no-bundle
rtk env NEXT_PUBLIC_E2E=1 PLAYWRIGHT_TAURI=1 pnpm exec playwright test \
  --project=tauri tests/e2e/tauri/<area>/<target>.spec.ts --workers=1
```

The E2E bridge must be compiled into the Tauri frontend build with `NEXT_PUBLIC_E2E=1`. An env set only when Playwright starts cannot restore a tree-shaken bridge.

## Fixture discipline

- Reuse the exported Tauri fixture; it owns the CDP page/context lifecycle.
- The project is serial: one WebView2 page/context and mutable mock scenarios must not interleave.
- Use existing control helpers for Anthropic or native services.
- Assert both the user-visible result and the native/IPC evidence when the latter is the reason the test belongs here.
- Keep pure command validation and edge cases in co-located Rust tests; E2E proves integration, not every branch.

## Failure evidence

Retain the Playwright artifacts plus:

- Tauri process stdout/stderr;
- missing or malformed `PLAYWRIGHT_TAURI_CDP_WS` diagnostics;
- Rust command error and payload;
- sidecar/service logs and mock control state;
- whether the binary was rebuilt from current source.

Do not relabel a platform launch failure as a product pass. Report lower-layer evidence and the exact Windows reproduction command.
