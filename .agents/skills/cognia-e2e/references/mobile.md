# Mobile E2E

## Scope

Use `tests/e2e/mobile/**` for Capacitor-shaped journeys: standalone/paired mode, discovery and pairing, offline/outbound queues, deep links, push/local notifications, permissions, safe areas, mobile navigation, gestures, media surfaces, and mobile persistence.

The Pixel 7 project is the primary Chromium mobile gate. The iPhone 13/WebKit project is opt-in via `PLAYWRIGHT_MOBILE_IOS=1` and runs on the scheduled/manual macOS job.

## Establish the correct mobile shape

- Read `playwright.config.ts`, the closest mobile spec, `tests/e2e/helpers/inject-capacitor.ts`, and `tests/e2e/helpers/db-reset.ts`.
- Inject the existing Capacitor mock before the application boot when the test requires native-plugin shape.
- Use `bootstrapCogniaMobile(page, "standalone" | "paired")` for boot/queue flows that must establish account and runtime mode before the in-app bridge exists.
- After `resetCogniaDb`, restore `mobileRuntimeMode` with `setCogniaSettings`; the reset removes the settings row and can otherwise redirect to `/welcome`.
- Use `createMockV2Server` or the shared V2 mock for paired/companion contracts. Prefer a per-spec server only when mutable scenario isolation is required.

Viewport alone does not prove Capacitor behavior. A Capacitor mock does not prove a real native plugin or Tauri IPC. State exactly which surface the spec covers.

## Commands

```bash
rtk pnpm exec playwright test --list \
  --project=mobile-pixel-7 tests/e2e/mobile/<target>.spec.ts
rtk pnpm exec playwright test \
  --project=mobile-pixel-7 tests/e2e/mobile/<target>.spec.ts --workers=1

rtk env PLAYWRIGHT_MOBILE_IOS=1 pnpm exec playwright test --list \
  --project=mobile-iphone-13 tests/e2e/mobile/<target>.spec.ts

rtk pnpm test:e2e:build
rtk env PLAYWRIGHT_STATIC=1 pnpm exec playwright test \
  --project=mobile-pixel-7 tests/e2e/mobile/<target>.spec.ts --workers=1
```

Install WebKit before the iOS project when needed. Do not append unrelated project flags to the package scripts without first checking their exact definitions.

## Gesture and time semantics

Prefer semantic end-state assertions. A literal timeout is only defensible when elapsed pointer/recording time is itself part of the simulated input and the exact occurrence is governed in `scripts/e2e/governance-exceptions.json`. Never use a sleep for post-action settling.

## Cross-platform coverage

- Share the same spec between Pixel and iPhone when the product contract is platform-neutral.
- Split only when engine/native behavior genuinely differs.
- Record WebKit-only or scheduled-only residual risk in the final report.
- Use Tauri specs for desktop native contracts; do not move them into mobile merely because both are “native”.
