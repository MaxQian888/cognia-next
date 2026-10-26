# Sidecar TypeScript migration — 2026-10-20

## Delivered scope

All 76 remaining handwritten `.mjs` files outside the compatibility launchers
have TypeScript replacements:

| Scope                                              | Files |
| -------------------------------------------------- | ----: |
| `sidecar/codeserver-agent-ext/src/` implementation |    18 |
| Broker build and deterministic VSIX ZIP utilities  |     2 |
| Broker tests                                       |    18 |
| VS Code host tests, harness and protocol fixtures  |    36 |
| Webclone tests                                     |     2 |

The source inventory excludes dependencies, generated output and caches. Ten
`.mjs` files intentionally remain: eight stable process launchers and the two
generated MCP bundles, `a2ui-mcp.mjs` and `cognia-mcp.mjs`. Rust, the CLI,
launchd and stored MCP configuration keep their existing entry paths.

The broker still bundles `extension.ts` and `proxy-extension.ts` into CommonJS
`dist/extension.js` and `dist/proxy.js`. Its package manifest's module boundary
is preserved. Nested test package markers make the tests ESM without changing
the compiled host or extension format. The copied LSP fixture's launch path is
updated together with its filename.

New package/test tsconfigs are reached by the existing `sidecar:typecheck`
command through `sidecar:packages:typecheck`, and by the individual package
test commands. VS Code host builds emit declarations so the migrated tests
check the compiled modules' actual source contracts; the existing
`TaskProvider` interface is exported to make that declaration build valid.
Broker connection state, credentials, handshake envelopes, proxy/provider
descriptors, storage and workspace panel DTOs now have explicit contracts.
Open third-party provider values, metadata and partial test doubles retain
explicit dynamic types; this migration does not claim zero `any` usage.

`legacyMjsAllowed` is now false. An inventory regression test rejects new
handwritten `.mjs` files across the nested packages as well as the main host.
Three existing renderer/provider adapter modules are explicitly listed in the
public architecture contract, resolving the six pre-existing import findings
without a wildcard allowance or baseline increase.

Build/catalog generators, capability test-evidence paths, generated API source
pointers, current documentation and stale source comments are updated. The
dated 2026-10-03 audit remains a historical snapshot.

## Verification

| Check                                                                                        | Actual result                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Pre-migration nested package tests                                                           | Broker 131, VS Code host 213, webclone 12 passed                                                 |
| `pnpm sidecars:test`                                                                         | 2,923 passed, 0 failed, 2 existing skips across the four package runs                            |
| `pnpm sidecar:typecheck`                                                                     | Passed, including main host, Pi and all three nested packages/tests                              |
| Broker tests after final type refinements                                                    | 131 passed                                                                                       |
| Relevant architecture/resource/build script tests                                            | 47 passed                                                                                        |
| `pnpm test -- --runTestsByPath lib/plugin/contracts/plugin-capabilities.test.ts --runInBand` | 11 passed, including the new evidence-path regression                                            |
| `pnpm sidecar:codeserver-agent:build`                                                        | Passed; generated VSIX and digest                                                                |
| `pnpm test:pro-ide:e2e --skip-build`                                                         | 26 passed against the real code-server after building the VSIX, extension host and Rust E2E host |
| `pnpm audit:sidecar-architecture`                                                            | Passed; 0 baselined findings                                                                     |
| `pnpm audit:pro-ide-constants`                                                               | Passed                                                                                           |
| `pnpm ide:check` / `pnpm companion-api:check`                                                | Passed                                                                                           |
| Scoped ESLint / formatting / `git diff --check`                                              | Passed for the migration scope                                                                   |

The real code-server suite covers both profiles, explorer placement, CodeLens
and command dispatch, supervised LSP/DAP/MCP, SCM, test outcomes, notebook
execution, webviews, chat/model/tools, extension-host restart/reconnection and
cross-profile plugin retention. The initial run stopped before assertions
because Chromium was absent. Direct Playwright downloads timed out; the exact
official headless-shell archive was downloaded from the same URL with curl and
installed by Playwright using a temporary loopback mirror. The mirror was
stopped after installation. No test assertions or timeouts were relaxed.

Independent PII and wiring audits compared all 76 original JavaScript files
with their replacements. After normalizing migrated paths, esbuild type
erasure produces identical executable JavaScript for all 76 pairs. The 44
main-host comment updates also produce identical JavaScript. A separate test
audit found no removed assertions, added skips or missing migrated test files.

## Repository-wide checks outside this migration

These checks ran and remain failing; they are not represented as passes:

- `pnpm typecheck`: `components/harness/harness-failure-offer.test.tsx:86`
  reports TS2698, and `components/harness/harness-snapshot-diff.test.tsx:4`
  reports TS2459 for `DiffLine`. Neither file is changed by this migration.
- `pnpm lint`: 81 errors and 4,856 warnings in unrelated files, chiefly the
  generated `src-tauri/resources/plugins/cognia-office/dist/index.js`, plus
  existing component/hook/extension warnings. Scoped migration lint passes.
- `pnpm lint:static-export`: the existing Node import in
  `lib/browser/extension-engine.ts:450` is rejected.
- The expanded build-script test selection passed 51 of 52 tests. The existing
  `build-webclone-sidecar.test.mjs` assertion still expects `tsc --noEmit` in
  the root command, while the current checkout already delegates to
  `scripts/gates/typecheck-root.mjs`. This migration preserves that wrapper.
- The gate registry still reports seven unrelated unregistered scripts:
  `host:archive:test`, `test:build`, `test:config`, `test:heavy`, `test:pty`,
  `test:unit`, and `update:catalog:test`. The new nested sidecar check is
  documented as delegated to the registered parent gate.

No coverage run, frontend static-export build, full Tauri packaging, remote CI,
commit, push or deployment was performed. The implementation remains in the
shared working tree alongside the user's existing changes.
