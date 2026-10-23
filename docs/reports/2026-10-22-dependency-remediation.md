# Dependency remediation — 2026-10-22

The published Storybook security fix is installed and verified. Remaining scanner matches have no compatible published patched release in their current dependency chains. No advisory ignore was added and no vulnerable version was labelled fixed.

## Changes

- All six root Storybook declarations move to 10.6.3: storybook, addon-docs, addon-mcp, nextjs, nextjs-vite and eslint-plugin-storybook. The framework retains its exact pin; the other declared ranges now have a 10.6.3 floor. Fourteen resolved package entries were added, seventeen superseded entries removed, including the orphan @next/env 16.4.0. All other package records and workspace importers remain unchanged.
- Removed the obsolete docs/pnpm-lock.yaml after checking its clean baseline, pnpm workspace membership, Docker inputs and CI install/cache paths. Docs uses the root lockfile (Next 16.4.2); docs/README.md now states that contract. The previous 35-match standalone graph was stale and is no longer an install artifact. This does not represent 35 newly patched runtime dependencies.
- Kept Sidecar, Rust, package-manager overrides, existing advisory exceptions and other concurrent changes intact.

## Audit results

Counts below are advisory/package-version matches, not confirmed product exploitability. Root production-only findings overlap the root full scan.

| Scope                         | Before                                   | After                                     |
| ----------------------------- | ---------------------------------------- | ----------------------------------------- |
| Root full pnpm graph          | 5: 2 critical, 1 high, 1 moderate, 1 low | 3: 0 critical, 1 high, 1 moderate, 1 low  |
| Root production graph         | 1 moderate                               | 1 moderate: sprintf-js                    |
| Sidecar                       | 1 high                                   | 1 high: braces                            |
| Other 13 JavaScript lockfiles | 0                                        | 0                                         |
| Main Cargo workspace          | 5                                        | 5                                         |
| Diagnostic service Cargo      | 1                                        | 1                                         |
| Other 5 Cargo lockfiles       | 0                                        | 0                                         |
| Obsolete standalone docs lock | 35                                       | Removed; root workspace contract verified |

All 22 remaining source lockfiles were scanned, plus the root production subset. Every lockfile retained the same hash during its audit. JSON and commands are under `.cache/security/2026-10-22/remediation-0330/final-audits/`. Cargo uses the refreshed 1,348-entry RustSec database with --no-fetch --no-yanked: registry yanked lookups previously timed out and remain a separate unverified item.

## Why remaining findings cannot be safely removed by an update

| Dependency                  | Current dependency chain                                                      | Current upstream evidence                                                                                                                        | Result                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| braces 3.0.3                | Root development tools; Sidecar fast-glob 3.3.3 → micromatch 4.0.8            | Latest braces is 3.0.3. Scanner-reported 3.0.4 returns npm E404; latest fast-glob/micromatch retain the same family.                             | No published compatible patched release.                                                                     |
| sprintf-js 1.0.3            | gray-matter/js-yaml/argparse and mammoth/argparse, including production paths | Latest sprintf-js 1.1.3 is still affected. Scanner-reported 1.1.4 returns E404. Latest gray-matter 4.0.3 and mammoth 1.13.0 retain old argparse. | Updating to 1.1.3 does not fix the advisory; forcing a different argparse major violates parent constraints. |
| elliptic 6.6.1              | Storybook Next.js webpack browser polyfills                                   | Latest elliptic is 6.6.1; scanner-reported 6.6.2 returns E404.                                                                                   | No published fixed version; replacing the framework/polyfill stack is a separate migration.                  |
| zip 4.6.1, three advisories | Windows Tauri updater 2.13.2                                                  | Latest stable updater 2.14.0 still declares zip ^4; fixes start at zip 9.                                                                        | No patched compatible parent; workspace's direct zip 9 cannot satisfy ^4.                                    |
| lopdf 0.38.0                | Optional parse-liteparse → liteparse 2.15.1                                   | Latest liteparse 2.16.0 still declares lopdf ^0.38; fix starts at 0.42.                                                                          | Requires an upstream patch or a separately reviewed parser migration.                                        |
| rsa 0.9.10                  | jsonwebtoken in root and diagnostic service                                   | Latest stable rsa is still 0.9.10; RustSec lists no patched version.                                                                             | Existing local-signing/JWT exception retained; no dependency fix claimed.                                    |

The ten Rust maintenance warnings and glib 0.18.5 unsoundness warning also remain. The existing Tauri/GTK3 exception was not expanded. Forcing ABI-incompatible GTK/glib versions would break the desktop stack.

## Compatibility and actual execution

- Root frozen install succeeded with 14 added/17 removed package entries. Docs-directory frozen lockfile-only install discovered all 55 root workspace projects and succeeded. Normal root install with ignored lifecycle scripts also completed. Existing unsupported-platform notices and a missing Windows agent bin link warning remain separate from Storybook.
- Installed readback confirms all six direct Storybook/tooling packages at 10.6.3. Peer check retains the unchanged optional tsconfck TypeScript ^5 versus 6.0.2 mismatch and unrelated xterm/addon-canvas mismatch; no Storybook-family version mismatch was introduced.
- Focused Jest: **33 suites, 742 tests passed** across Storybook fixtures, plugin/frontmatter conversion, and office/Markdown parsers.
- Actual Storybook dev server ran the repository's unchanged webpack configuration at 127.0.0.1:6106, indexed 3,757 entries, and rendered existing StatusBadge and AnalyzingImage stories in Chromium. StatusBadge light/English and dark/Chinese variants were inspected and screenshots retained. No uncaught browser page error was reported. Console output contains existing missing status translation keys in the selected story and the next-themes script-render warning; these are not described as a clean console or modified in this dependency task.
- Security/runtime probes: iframe responses carry `Content-Security-Policy: frame-ancestors 'self'` plus local origins; an untrusted Origin POST to /mcp returns **403 Invalid origin**. A trusted local Origin initializes successfully with HTTP **200**, protocol 2025-03-26 and serverInfo @storybook/addon-mcp **10.6.3**. No project-writing MCP tool or external provider was invoked.
- Docs typecheck passed. The complete production build/static export passed: **2,228 pages**, with the post-build search-index preparation completing. Two CSS pseudo-element warnings and recovered page-generation timeout retries are retained in the log. The exported `/en/docs.html` was then served locally, opened in Chromium and visually inspected; `docs-static-preview.png` records it.
- Read-only preflight review found no static-export or docs-lock ownership regression. Source scope assertions confirm all non-root workspace importers are identical and the dependency delta is confined to the Storybook family; unchanged Rust/Sidecar manifests and locks were hash-checked against the task baseline.

## Checks blocked by concurrent work

- Full root typecheck exited 2 with TS6053 missing-file diagnostics while plugin/queue files were being moved in another session. No Storybook-specific type error was reported in that output.
- Full lint exited 1 because lib/plugin/character-pack/pack-trust.ts contains an unused LocalCharacterPackSignature warning and the gate allows zero warnings. That path is outside this task's changes.
- These failures are preserved, not suppressed or repaired by modifying parallel work. No full main-app or native Tauri acceptance is claimed. No commit, push, release or deployment was performed in this follow-up.

## Evidence and sources

Reproducible evidence: `.cache/security/2026-10-22/remediation-0330/` contains baseline manifests/locks/hashes, lock-diff.json, registry/crates.io JSON, unpublished-fix-versions.json, actual install/audit/test/type/lint/build logs, browser screenshots, MCP/CSP responses, and final scope assertions. The [evidence ledger](../evidence/2026-10-22-dependency-remediation.md) tracks verification boundaries.

- [Storybook maintainer security advisory](https://github.com/storybookjs/storybook/security/advisories/GHSA-f2ph-cmg5-wxc8)
- [RustSec ZIP extraction advisory](https://rustsec.org/advisories/RUSTSEC-2026-0367.html)
- [RustSec lopdf advisory](https://rustsec.org/advisories/RUSTSEC-2026-0187.html)
- [RustSec rsa advisory](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)
- Live npm exact-version/latest metadata and crates.io stable-release dependency metadata were queried on 2026-10-22; raw responses are retained in the evidence directory.
