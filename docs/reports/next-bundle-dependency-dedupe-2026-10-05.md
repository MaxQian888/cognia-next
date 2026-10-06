# Dependency deduplication — 2026-10-05

The application and Streamdown now resolve one Shiki runtime. The five local schema packages share the host Zod runtime, eliminating the duplicate AI SDK peer contexts. This implements P1-A from [the P1 analysis](../research/2026-10-05-next-bundle-p1-analysis.md).

## Changes

| Dependency boundary                   | Before                                             | After                                                 |
| ------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `@streamdown/code`                    | `1.1.1`, using Shiki `3.23.0`                      | Exact `2.0.0`, using Shiki `4.5.0`                    |
| Root Shiki                            | `4.4.3`                                            | Exact `4.5.0`, shared with the code plugin            |
| Local schema packages                 | Zod `4.4.3` peer resolution alongside host `4.6.5` | Root and five workspaces use the `zod: 4.6.5` catalog |
| `ai@7.0.116` peer contexts            | Two: Zod `4.4.3` and `4.6.5`                       | One: Zod `4.6.5`                                      |
| `@ai-sdk/openai@4.0.78` peer contexts | Two: Zod `4.4.3` and `4.6.5`                       | One: Zod `4.6.5`                                      |

The five packages are `eval-core`, `provider-core`, `provider-types`, `rag`, and `router-fusion`. Each declares `zod: catalog:` as a development dependency while retaining its existing peer declaration. Only the root and these five lockfile importers changed relative to the pre-implementation snapshot. Other existing manifest edits belong to concurrent work.

The lockfile still contains Zod `3.25.76` for consumers requiring v3, and `4.4.3` for build-time Serwist dependencies. No global Zod override was added. Fresh client Analyzer module paths contain only Shiki `4.5.0`, Zod `4.6.5`, and the expected single AI/OpenAI SDK peer context.

## Measured output

Both snapshots use production Webpack with Next.js `16.3.6` and `@next/bundle-analyzer`. MiB means 1,048,576 bytes. The earlier baseline precedes P0 and concurrent project changes: whole-bundle differences are observed changes, not an isolated causal estimate for this patch.

| Metric                                               | Earlier baseline | Current output |      Observed change |
| ---------------------------------------------------- | ---------------: | -------------: | -------------------: |
| Analyzer client assets, including async assets       |       208.73 MiB |     187.99 MiB |  −20.74 MiB (−9.94%) |
| Sum of gzip sizes per client asset                   |        59.90 MiB |      55.84 MiB |   −4.06 MiB (−6.78%) |
| Analyzer client asset count                          |            4,462 |          3,834 |                 −628 |
| Homepage referenced modern JavaScript                |        22.88 MiB |      22.01 MiB |   −0.87 MiB (−3.81%) |
| Homepage JavaScript, gzip per asset                  |         6.36 MiB |       6.14 MiB |   −0.21 MiB (−3.38%) |
| Shiki and `@shikijs/*` attributed module occurrences |        39.35 MiB |      20.62 MiB | −18.72 MiB (−47.58%) |

Shiki attribution includes repeated module occurrences and Analyzer estimates inside concatenated modules. It is not an exact independently removable byte count. All 3,834 Analyzer assets exist in the final export and their file sizes match the report. No startup, latency, or memory improvement is claimed.

The final static export is 374.30 MiB, versus 515.21 MiB in the original baseline. This includes the earlier P0 asset cleanup: all 75 authoring files are absent from `out/` and its service worker, and all 178 runtime image hashes match the P0 baseline.

## Verification

- Added `scripts/build/dependency-dedupe.test.mjs`, using real installed packages outside Jest's Streamdown/Shiki mocks. It verifies module identity, shared AI SDK peer contexts, dual-theme highlighting, TypeScript/Bash/Vue/Elixir aliases, incomplete streaming completion, unknown-language fallback, and Zod-to-AI schema conversion and validation. It is discovered by the existing `scripts:test:build` glob.
- Before alignment: 3 tests passed and 3 identity checks failed. After alignment, including a rerun after the build: **6 passed, 0 failed**.
- Existing focused Jest coverage of highlighting, streaming, providers, schemas, RAG and evaluation: **11 suites, 571 tests passed**. No coverage collection was requested or run.
- All five affected workspace typechecks passed.
- A production browser fixture using the real Streamdown code plugin completed an incomplete code fence and rendered TypeScript, Bash and Vue. Light/dark keyword colors matched `#A626A4` and `#C678DD`. This verifies the dependency integration, not full application E2E or native shells.
- Focused ESLint, formatting, i18n key parity and sorting checks passed. Static-export dependency review found no new server-only boundary.

`pnpm run build:analyze` compiled successfully in 10.6 minutes and emitted fresh reports. Its first static-generation attempt exited 1 after `ENOSPC: no space left on device`. Only nine incomplete `*.pack_` temporary cache writes created by that failed build were removed (8,081,609,146 bytes); existing valid caches were retained. The installed Next.js CLI's generation stage then completed all 127 pages and static export with exit 0:

```sh
NODE_OPTIONS=--max-old-space-size=16384 node node_modules/next/dist/bin/next build --webpack --experimental-build-mode generate
```

This is successful compilation plus a successful resumed export, not a claim that the original build command exited successfully. Production configuration skips TypeScript validation. Whole-repository typecheck still fails on unrelated external-agent test/migration types, identity tests, and push notification timer types. Whole-repository lint also fails on unrelated source findings and generated iOS archive files. The focused checks above do not establish that those global gates pass. Tauri, Capacitor and the separate docs application were not built or exercised.

## Reproduction and evidence

```sh
node --test scripts/build/dependency-dedupe.test.mjs
pnpm --workspace-concurrency=1 --filter @cognia/eval-core --filter @cognia/provider-core --filter @cognia/provider-types --filter @cognia/rag --filter @cognia/router-fusion --no-bail run typecheck
pnpm run build:analyze
```

Local raw evidence is preserved under `.cache/bundle-analysis/2026-10-05/p1-implementation/`: pre-change manifests and lockfile, identity snapshots, failing/passing test logs, lockfile importer comparison, browser fixture/results, build and generation logs, fresh Analyzer HTML, bundle and route JSON, and export consistency checks. The earlier baseline remains in the parent directory.

## Sources

- [pnpm catalogs](https://pnpm.io/catalogs): shared dependency versions across workspace manifests.
- [pnpm install](https://pnpm.io/cli/install): workspace installation and lockfile behavior.
- [Streamdown code plugin](https://streamdown.ai/docs/plugins/code): code plugin integration and theme configuration.
- Installed Next.js `16.3.6` CLI documentation at `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`: experimental build modes.
