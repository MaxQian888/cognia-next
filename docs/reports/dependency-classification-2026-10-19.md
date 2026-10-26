# Dependency classification: first implementation batch

Date: 2026-10-19

This batch fixes dependency ownership and installation boundaries without upgrading
runtime libraries. Other work is active in the same checkout; unrelated source,
test-runner and TypeScript toolchain changes are outside this report.

## Classification and ownership

- Root: move `@babel/types` to development dependencies; move `fake-indexeddb`
  and `commander` to runtime dependencies. `pnpm start` imports Commander through
  the static-server entry, and headless database initialization loads IndexedDB.
- Keep CLI-only `chalk`, `cli-highlight`, `ink` and `marked` in root development
  dependencies for the build toolchain; declare them as CLI runtime dependencies.
- CLI: move `@types/ws` to development dependencies and `yaml` to runtime
  dependencies. Declare the complete set of 143 external npm packages observed
  in the production esbuild output, including packages in lazy chunks. These
  chunks currently reach shared application/UI modules; reducing that graph is
  a separate architecture change.
- Align the CLI's `undici` declaration with the existing resolved version
  `7.30.0`. The old `^8.11.2` declaration was overridden to 7.x by the root
  workspace and would select a different major outside the workspace.
- Mobile: move `@capacitor/core` to runtime dependencies. Docs: move the
  build-only `unist-util-visit` to development dependencies.
- Add 42 root workspace dependencies, seven CLI source-build workspace
  dependencies, four public type dependencies to `agent-config-types`, and the
  `provider-types` dependency to `diagnostics`.
- Add missing `nanoid` dependencies to provider-core/provider-routing and `yaml`
  to document. Complete the existing provider peer strategy with Azure, the
  Tauri-only optional integration, and four embedding provider SDKs; local
  development versions reuse the existing versions/catalog.
- Sidecar: explicitly declare development-time `@ai-sdk/provider` types and
  `esbuild`, using versions already present in the repository. Approve esbuild's
  required install script in the sidecar's existing `allowBuilds` policy.

Source imports, the plugin host shared-module whitelist, SDK builds and runtime
output were checked before deleting root `@ai-sdk/react`, `@hookform/resolvers`,
`@radix-ui/react-slot` and `@tauri-apps/plugin-shell`. Remove obsolete associated
Knip/transpile entries. Remove `@types/js-yaml` because js-yaml 5 supplies its own
declarations, and remove the unreferenced agent-claude-code development dependency
on `@cognia/redact`.

## Build contracts

The CLI build now checks esbuild's emitted external imports against its runtime,
peer and optional dependencies. A package available only through the repository's
development dependencies makes the build fail before asset staging or release.
The check applies to every emitted chunk, not only the entrypoint.

Adding legitimate root workspace dependencies exposed an existing tsup constraint:
DTS generation unconditionally externalizes the current directory's production
dependencies. SDK package declarations and author declarations now run from unique
temporary CommonJS directories under `.cache`, retaining third-party externals
while flattening internal Cognia types. The real manifest is never rewritten.
Success and exception cleanup are tested, including nested concurrent builds.

Both the main and independent sidecar lockfiles are updated. Existing runtime
resolutions were retained, including restoring unrelated transitive resolution
changes proposed during lockfile recalculation. Newly added main-lock entries
for web-clone/parser dependencies reuse versions already locked by the existing
webclone or sidecar installation. The concurrent TypeScript toolchain migration
is preserved separately.

## Verification

Passed:

- Main and sidecar frozen-lockfile checks.
- Full CLI JavaScript build, with all 143 external package contracts satisfied.
- A separate pnpm production deployment with no Cognia workspace links. The
  current CLI build was copied into it; runtime packages resolve inside the
  deployment rather than the source checkout.
- Isolated CLI `--help`, `--version` and piped `/help` + `/exit` chat startup.
- Compiled headless IndexedDB/Dexie read/write, CLI Markdown tokenization and
  highlighting, and ACP PTY spawn/output/exit in that production installation.
- 30 script tests for dependency deduplication, artifact integrity, package
  boundaries and the changed build helpers; the scoped reviewer additionally
  ran the existing SDK package artifact tests successfully.
- 54 targeted Jest tests for Babel linting, permission inference and headless
  IndexedDB; 18 sidecar LSP-loader/OAuth-helper tests.
- Scoped ESLint, i18n key/literal lint, message/NLS freshness, ICU validation,
  locale sorting and whitespace checks.
- Full SDK package JavaScript/declaration build with the isolated DTS directory.

Broader checks are not green:

- Full repository lint reports existing application/test issues and a generated
  office-plugin resource bundle (81 errors and 4,856 warnings in that run).
- The full typecheck run reports 48 errors in other source/test work, including
  web-cache contracts and settings-sync. No business files were changed by this
  dependency batch.
- A later author-DTS run encounters the concurrently changing
  `lib/web/web-tools-core.ts` / `FetchCacheKeyInput.method` contract.
- The static-export gate reports the existing Node filesystem import in
  `lib/browser/extension-engine.ts`; the scoped audit found no new violation.

Coverage, native desktop/mobile builds and live vendor calls were not run.
General peer-to-dependency migrations, broad peer range tightening, and further
unproven deletion candidates remain outside this first batch.

## Second review and repairs

The second review re-scanned current imports and emitted CLI chunks, checked
deleted packages against source and plugin-host contracts, and compared both
lockfiles with the saved pre-implementation and pre-review snapshots.

Repairs:

- Declare the CLI OAuth provider's type-only `@modelcontextprotocol/sdk` import
  as a development dependency, using the already locked 1.32.1 version.
- Complete direct development imports and explicitly configured test types in
  the touched workspaces: CLI/docs testing libraries, mobile JSZip and the
  TypeScript JavaScript API, four packages' tsup configs, Jest/Node types, and
  root `@jest/globals`. Versions reuse the current lockfile; mobile uses the
  concurrent root TypeScript API alias without changing the compiler migration.
- Align CLI `postcss` to 8.5.29, the existing effective workspace resolution.
  Its earlier 8.5.28 declaration would select a different version outside the
  workspace override.
- Require an own manifest property in the CLI external-dependency guard.
  The regression test first reproduced an undeclared `constructor` package
  incorrectly passing through the object prototype, then passed after the fix.

The updated root lockfile changes importer declarations only relative to the
pre-review snapshot: no package records, integrity hashes, dependency snapshots,
or resolved versions changed. Lockfile recalculation attempted an unrelated
Mammoth-to-JSZip edge update; that edge was restored before frozen installation.
The sidecar lockfile is unchanged by this review. No mistaken deletions or new
production/workspace import omissions were found in the reviewed scope.

For the original batch, surviving package records retain their saved versions
and integrity. New root records reuse existing webclone/sidecar versions and
integrity, while their dependency contexts can reuse existing root resolutions
(for example css-tree uses root source-map-js 1.2.2; webclone uses 1.2.1).

Fresh review validation passed:

- Root frozen installation and sidecar frozen-lockfile check.
- CLI build: 7,077 inputs and 2,768 outputs, with no undeclared runtime imports.
- Full SDK JavaScript/declaration build using the isolated declaration root.
- Isolated production IndexedDB/Dexie, Markdown/highlighting and ACP PTY probes.
- 38 build/dependency/package-boundary script tests and 18 sidecar tests.
- 40 mobile tooling tests and 42 targeted Jest tests across CLI, docs and headless DB.
- Direct dependency resolution from each repaired workspace, scoped ESLint,
  formatting and whitespace checks.

The legacy manual `build-cli-binary.mjs` pkg branch still documents an external
`@yao-pkg/pkg` prerequisite without a locked version. Current release scripts use
Bun and invoke this helper with `--layout-only`, which skips that branch. No
new version was selected for this separate manual toolchain in this batch.
The previously reported full-repository lint/typecheck/static-export limitations
remain outside this dependency repair; this review does not claim those gates
are globally green.
