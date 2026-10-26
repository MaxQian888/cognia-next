# Node.js, frontend, and Cloudflare dependency security audit

Date: 2026-10-22 (Asia/Shanghai). Scope: checked-out dependency graphs and local verification. Changes are uncommitted. Production deployments and previously distributed desktop/container artifacts have not been updated.

## Findings and updates

The local Node.js executable was v26.5.0, the desktop plugin runtime pin was 26.3.1, and container runtime pins were 26.8.2 or 26.3.1. The Node.js security release dated 2026-10-21 fixes affected 26.x releases in **26.12.1**. Installed 26.12.1 locally and used it for verification; updated `.nvmrc`, the desktop plugin runtime version and six official SHA-256 digests, the agent bundle version manifest, bundle/runner Dockerfile pins, and the server Dockerfile's plugin-node-runtime stage. Prepared and checked the actual macOS ARM64 plugin runtime, which reports v26.12.1. Existing processes require restart; container images and desktop installers require rebuilding and distribution.

Main app Next.js 16.4.0 and docs/web 16.3.6 preceded the October security fixes. All three manifests now require ^16.4.1 and resolve **16.4.2**. Updated matching Next tooling and Sharp. The app, docs, and website use static export, reducing exposure to vulnerabilities in request-time Server Actions, Cache Components, and default image optimization. This is an exposure assessment from configuration, not proof that every application dependency is safe.

Aligned React and React DOM at **19.3.1**, the October 14 upstream patch, across root/CLI/docs/web/browser-extension manifests and the central workspace overrides. Verified installed versions in all five consumers, rather than relying on manifest changes alone; the central overrides otherwise keep the installed runtime at 19.3.0. Regenerated the artifact React runtime bundle.

Updated root and CLI MCP client/core together to 2.3.0, and sidecar MCP SDK to 1.32.1. Patched vulnerable transitive HTTP, XML, math, URL/link parsing, image, and build-tool dependencies. Existing brace-expansion overrides retain each minimatch parent's compatible API family. GitHub runner artifact SDK moved from 2.3.2 to 6.3.1 instead of forcing incompatible Octokit internals; bootstrap already uses dynamic ESM import, and its upload API remains available.

## Audit results

Full dependency audits include development dependencies. Counts are advisory matches for pnpm and affected-package aggregates for npm; do not add them into one comparable total.

| Dependency graph                                                       |                            Before |                        After |
| ---------------------------------------------------------------------- | --------------------------------: | ---------------------------: |
| Root pnpm workspace, including CLI/docs/web/mobile/extensions/packages |                   42 (1 critical) | 3: 1 high, 1 moderate, 1 low |
| Independent sidecar pnpm graph                                         |                   36 (1 critical) |                       1 high |
| Status admin                                                           |                                 3 |                            0 |
| Status probe                                                           |                                 3 |                            0 |
| Office plugin runtime                                                  |                                 1 |                            0 |
| Webclone npm graph                                                     |                                 1 |                            0 |
| VS Code extension host npm graph                                       |                                 1 |                            0 |
| Agent bundle npm graph                                                 |                                 4 |                            0 |
| GitHub runner npm graph                                                |                                10 |                            0 |
| LaTeX workbench vendor npm graph                                       |                                 3 |              0, plugin 0.1.1 |
| Five independent Cloudflare pnpm graphs                                | 15/16 each before service updates |                       0 each |
| Unused legacy docs standalone lockfile                                 |                   35 (3 critical) |    35, historical graph only |

The old `docs/pnpm-lock.yaml` is not the installed docs graph: ordinary auditing/installing from docs selects the root pnpm workspace. A separate `--ignore-workspace` audit did inspect the historical lock and found 35 matches (Next.js, Sharp, PostCSS, esbuild, source-map-js, js-yaml, nanoid, baseline-browser-mapping). Current CI installs from inside the full checkout and caches the root lock; Docker build inputs also use the root workspace. Preserved the unused historical lock instead of silently treating it as repaired or deleting it during the active-graph update. It needs separate retirement before anyone attempts a detached docs install. A trial regeneration was reverted; its intermediate five-match audit is not the final state. Audit results are a dated advisory database snapshot, not a complete security proof. The official Next.js bulletin was also checked because registry audit output alone did not cover the newest 16.4.0 issue.

## Unresolved dependency findings

- **braces 3.0.3**, high, GHSA-vfj7-8cjw-p6xm: root and sidecar graphs. Registry has not published the advisory's 3.0.4 repair version as of this check; current latest is 3.0.3. Root paths include build tools and sidecar uses fast-glob/micromatch. No advisory suppression added.
- **sprintf-js 1.1.3**, moderate, GHSA-hp3w-g68c-fv3c: root document/build parsing dependencies. Referenced repair 1.1.4 was not published; latest was 1.1.3.
- **elliptic 6.6.1**, low, GHSA-848j-6mx2-7j84: Storybook crypto polyfill development tooling. Referenced repair 6.6.2 was not published; latest was 6.6.1.
- **LaTeX workbench follow-up resolved:** plugin 0.1.1 vendors source commit `76567ee5deaaf279e6f3945e9ca3aecb880e45ac`, upgrades development SDK/TUI from 0.85.1 to 1.3.0 and removes the old embedded shrinkwrap graph. Clean development and prepared runtime audits both report zero known advisories. Runtime peers support the verified Pi 1.0.2 and 1.3.0 hosts; no host SDK is bundled in the plugin. Actual archive preparation, import/build/check/text/page render and governed hosted-session loading passed. See [the evidence ledger](../evidence/2026-10-22-latex-plugin-security-upgrade.md). The previous lock-only workaround was rejected; the current result uses a real installed graph.

The root critical shell-quote finding was in Changesets/launch-editor development tooling. The sidecar critical proxy-addr finding requires particular proxy trust configuration. A version match establishes an affected dependency, not that either exploit was reachable in the deployed application.

## Verification

Successful local checks:

- Root frozen install, including its normal postinstall and Husky preparation; sidecar frozen install.
- Node runtime preparation/version check and official archive checksums; 33 Node packaging/version tests; bundle pin consistency check.
- Final focused Jest sweep covers root/CLI MCP, LaTeX, Markdown rendering, document parsing, and ANSI parsing: **61 suites, 917 tests passed**.
- Webclone: **12 tests passed**; extension host: **213 tests passed**.
- GitHub runner bootstrap: **9 tests passed**; real installed artifact SDK imports, constructs, and exposes uploadArtifact without network activity.
- Deployment gate tests: **42 passed**; artifact runtime tests: **10 passed**.
- Status admin/probe: typecheck and build passed; **25 + 190 tests passed**.
- Docs typecheck passed. Final docs (**2,228 generated paths**) and website (**27 generated paths**) production static builds passed with Next.js 16.4.2 and installed React/React DOM 19.3.1. Docs emitted CSS/cache warnings and retried a few slow routes before completing successfully. Website metadata preparation and the post-upgrade build both completed.
- Browser extension Chrome MV3 production build passed; large-chunk warnings remain. No browser/native interaction acceptance was performed.
- Scoped `git diff --check` passed.
- Scoped script lint and manifest/config formatting checks passed. No coverage check was requested or run.

Whole-tree checks reveal additional problems outside the dependency edits:

- Final `pnpm lint`: **19 warnings**, fails the zero-warning policy, across five source files including `lib/ai/media/provider-generation.ts`, `lib/connectors/a2ui-bridge/surface-builder.ts`, and concurrent agent/provider paths. An earlier run reported 16; the shared tree is changing during verification.
- `pnpm lint:static-export`: **3 Node-only imports**, in `lib/browser/extension-engine.ts` and `lib/plugin/core/builtin-artifact-fixture.ts`. Both source files are unchanged from HEAD.
- `pnpm build`: fails during prebuild because `scripts/build/mcp-bridge-runtime.ts` does not export createCharacterVariant, listCharacterVariants, listResolvedCharacters, or duplicateSkill imported by prompt adapters. These source files are unchanged from HEAD. Main Next build/export was therefore not reached.
- `pnpm typecheck`: fails in concurrent agent/compaction/plugin/smoke paths; exact diagnostics retained. No MCP SDK API diagnostics were reported.
- Independent `pnpm sidecar:typecheck`: fails in compaction source/tests.
- Full sidecar suite: **2,586 passed, 4 failed, 2 skipped** (2,592 reported tests). Two failures come from an extensionless Pi subagent import; two source-shape assertions do not find PlanStatus/PlanStepStatus unions. All four reproduce using the previous Node 26.5.0, so they are not established Node patch regressions.

Main-app browser/native acceptance is blocked by the build failures; passing dependency tests does not establish a releasable application. Read-only static-export and PII preflight reviews found no new issue in the scoped dependency changes. The review caught the vendor lock mismatch; a clean-install reproduction confirmed its upstream shrinkwrap constraint and it remains explicitly unresolved.

Container images were not built or pulled. An optional Docker Hub manifest availability lookup did not return and was cancelled; image availability and container runtime acceptance remain unverified.

## Cloudflare deployment boundary

Prepared updates for share, status, update, identity, and sync Workers: each full dependency audit is zero; each typecheck, unit suite, and Wrangler dry-run build passed (**592 tests** total). Logto email's **36 tests** passed. Rebuilt the Rust signaling Worker with its locked dependencies successfully. The signaling Cargo graph has no RustSec matches in this scan.

**No production Worker was deployed.** Wrangler's stored login expired and could not refresh. GitHub CI has no Cloudflare credentials configured. Opened the authorization page in the user's Google Chrome as requested; authentication was still expired at the final read-only check. The earlier device code expired and must not be reused. Deployment, binding verification, deployed-version readback, and live smoke acceptance remain outstanding until login is restored. Initial automated health requests encountered Cloudflare edge 403/1010; that does not establish application health or failure.

## Evidence and sources

Raw audits, registry publication checks, Node official checksum list, and verification logs: `.cache/security/2026-10-22/node-frontend/`. Cloudflare logs: `.cache/security/2026-10-22/cloudflare/`. Rust results: `docs/evidence/2026-10-22-rust-security-dependencies.md`.

- [Node.js 2026-10-21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Next.js 2026-10-14 security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
- [React 19.3.1 release](https://github.com/react/react/releases/tag/v19.3.1)
- [Next.js static export restrictions](https://nextjs.org/docs/app/guides/static-exports)
- [Shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)
- [Proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
- [MCP OAuth credential destination advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
- [MCP cross-origin redirect advisory](https://github.com/advisories/GHSA-6prh-2h8m-c8cw)
- [Actions artifact release notes](https://github.com/actions/toolkit/blob/main/packages/artifact/RELEASES.md)

## Security remediation follow-up — 2026-10-22

A fresh audit identified two critical package matches in the Storybook 10.6.1 development-server family. All six direct Storybook/tooling declarations now require 10.6.3, with the resolved family aligned at that release. Critical matches are gone; root audit retains one high (braces), one moderate (sprintf-js), and one low (elliptic). Exact registry checks return E404 for the scanner-reported fixed versions 3.0.4, 1.1.4 and 6.6.2; latest compatible parents retain the affected packages. No fabricated-version override or new advisory ignore was added.

The obsolete independent docs/pnpm-lock.yaml was removed after confirming workspace and CI ownership. Docs continues to resolve Next 16.4.2 through the root lock; its frozen install, typecheck, and complete 2,228-page static export passed. This removes a stale dependency artifact, rather than claiming 35 runtime packages were newly patched.

See [the remediation report](2026-10-22-dependency-remediation.md) for actual Storybook/browser/MCP evidence, remaining Rust parent constraints, concurrent-tree gate failures, and complete per-lock results.
