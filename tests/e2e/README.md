# End-to-end testing

Playwright tests in this directory prove user-visible behavior and integration
contracts. A route visit or a visible button is not coverage unless that is the
contract being protected.

## Test contract

Write the contract before the spec:

```text
precondition / entry → user action → observable result → failure diagnostic
```

- Prefer accessible roles and names, then stable test IDs when no semantic
  locator exists.
- Wait for UI state, requests, persisted rows, or public events. Do not add
  `waitForTimeout` to make a race disappear.
- Use the smallest reliable harness. Browser-owned UI and request contracts use
  deterministic routes/mocks; Tauri IPC and sidecar boundaries stay in the
  opt-in `tauri` project.
- Keep setup in helpers, but leave the behavior-driving action and assertion in
  the spec.
- A test that cannot currently run belongs in the governance debt ledger, not
  behind an untracked `skip`, `fixme`, or swallowed failure.

`pnpm audit:e2e-governance` enforces these rules. Existing exceptions are exact,
time-bounded entries in `scripts/e2e/governance-exceptions.json`; removing debt
must also remove or shrink its entry.

## Projects and commands

| Scope            | Command                                        | Ownership                                                                  |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Browser          | `pnpm exec playwright test --project=chromium` | Desktop web-mode UI, static-export routes, deterministic request contracts |
| Android viewport | `pnpm test:e2e:mobile`                         | Capacitor-shaped mobile journeys and mobile persistence                    |
| iOS viewport     | `pnpm test:e2e:mobile:ios`                     | Weekly WebKit compatibility                                                |
| Tauri            | `pnpm test:e2e:tauri`                          | Windows-only WebView2/CDP, IPC, sidecars, keyring, native integrations     |
| Workflow slices  | `pnpm test:e2e:workflows[:nodes                | :editor                                                                    | :runs]` | Workflow editor, executor, and run-history contracts |

For CI-equivalent local verification, always rebuild the export first:

```bash
pnpm test:e2e:build
pnpm test:e2e:static
```

The static server verifies that an E2E bridge exists, but it cannot prove an
old `out/` artifact matches the current source and helpers. A focused static run
against stale output can therefore fail during bootstrap even when a dev-server
run passes.

## Verification ladder

1. `playwright test --list` for the target project/spec.
2. Target spec with one worker.
3. Related directory/project suite.
4. Fresh static-export run for browser/mobile changes.
5. Cross-project or Tauri combinations only when the contract crosses those
   boundaries.

Retain the first failing trace, screenshot, video, browser console, and mock
service log. Do not respond to a deterministic failure by widening retries or
timeouts.

The current module coverage ledger and prioritized gaps live in
`docs/plans/2026-07-18-e2e-module-coverage.md`.
