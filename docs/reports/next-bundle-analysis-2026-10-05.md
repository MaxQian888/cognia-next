# Next.js bundle analysis — 2026-10-05

The current web/desktop export contains **208.73 MiB of bundled client JavaScript** across **4,462 chunks**. The homepage HTML references **22.88 MiB of JavaScript (6.36 MiB gzip)** in 268 modern-browser scripts. The highest-impact findings are the large shared application runtime, large eagerly imported data/validation modules, duplicated dependencies and async chunks, and development artwork included in the PWA precache.

## Measurement and reproduction

- Main application only; not the separate docs/web apps, Capacitor mobile variant, or native sidecars.
- Next.js **16.3.6**, Webpack, official `@next/bundle-analyzer` **16.3.6**.
- Baseline: working tree based on `b7a982a04`, including existing uncommitted changes and installed dependencies. Other work continued in the shared tree, so this is a build snapshot, not a clean-commit benchmark.
- Command: `pnpm build:analyze` (added by this analysis). It runs the normal prebuild/build/postbuild lifecycle with `ANALYZE=true`.
- Build exited **0**; compilation took **11.9 minutes**; **127/127** static pages generated. Build-time TypeScript checking is disabled by the existing configuration, so build success does not establish a full typecheck pass.
- Reports are generated at `.next/analyze/client.html`, `nodejs.html`, and `edge.html`. Normal builds leave analysis disabled. Reports do not automatically open browser tabs.
- This run's reports, extracted data, build log, and measurement scripts are preserved under `.cache/bundle-analysis/2026-10-05/`. This directory is ignored by Git.
- Interactive full report: [client treemap](http://127.0.0.1:4001/client.html). Filtered report: [homepage initial chunks](http://127.0.0.1:4001/home-client.html). These URLs require the local report server; restart it with `python3 -m http.server 4001 --bind 127.0.0.1 --directory .cache/bundle-analysis/2026-10-05`.

The plugin is the appropriate analyzer for this project's `next build --webpack` production command. The built-in `next experimental-analyze` measures Turbopack instead. See [Next.js package-bundling documentation](https://nextjs.org/docs/app/guides/package-bundling).

All sizes below use binary MiB (1,048,576 bytes). Total bundle size includes async chunks; it is not a first-load estimate. Gzip is summed per file, not a measurement of a deployed server's transfer encoding. Concatenated-module attribution in the analyzer is approximate; individual module sizes must not be treated as guaranteed removable bytes.

## Overall size

| Scope                                     |       Size | Meaning                                                 |
| ----------------------------------------- | ---------: | ------------------------------------------------------- |
| All emitted client JS                     | 208.73 MiB | 4,462 chunks, including deferred features               |
| All emitted client JS, gzip               |  59.90 MiB | Sum of analyzer gzip sizes                              |
| Static export `out/`                      | 515.21 MiB | 7,341 files; includes public assets and route output    |
| All JS in `out/`                          | 248.27 MiB | Includes Monaco/OCR/runtime files copied from `public/` |
| `public/` before generated service worker | 250.07 MiB | 2,062 files; separate from Webpack module analysis      |
| `public/icons/`                           | 173.02 MiB | Includes raw artwork, PNG/WebP variants, QA images      |

The server report has 2,537 chunks totaling approximately 85.86 MiB parsed. These are build/server artifacts, not an additional browser download. The edge report contains no bundles; its “No bundles were parsed” message is not a client-analysis failure.

## Initial route JavaScript

These numbers come from the completed export's actual `<script src>` tags, deduplicated by URL. They include shared layout/runtime chunks, exclude `noModule` compatibility scripts, and use gzip level 9. They do not include CSS, images, locale/data requests, service-worker precaching, or additional imports triggered after hydration. They are static first-load references, not a browser network/performance trace.

| Route               | Script files |    Parsed |     Gzip |
| ------------------- | -----------: | --------: | -------: |
| `/`                 |          268 | 22.88 MiB | 6.36 MiB |
| `/me`               |          276 | 23.20 MiB | 6.46 MiB |
| `/plugins`          |          282 | 24.00 MiB | 6.69 MiB |
| `/remote-sessions`  |          313 | 26.95 MiB | 7.53 MiB |
| `/workflows/editor` |          285 | 25.16 MiB | 6.99 MiB |
| `/logto/callback`   |          267 | 22.75 MiB | 6.31 MiB |
| `/onboarding`       |          273 | 23.41 MiB | 6.52 MiB |

Inspecting only the analyzer's `app/page` entry would show 5.25 MiB and undercount the homepage: `app/layout` and shared runtime files must also be included. The similar size of the login callback and main page points to the global runtime as the first place to investigate.

`app/layout.tsx` imports `AppRuntime`, and `components/runtime/app-runtime.tsx` statically imports a broad provider/initializer/host graph. Conditional rendering and account/lightweight-route gates do not remove those static imports from the bundle. Refactoring should establish lazy module boundaries or separate route layouts while preserving initialization order and account gates.

## Largest actionable contributors

### 1. Eager data and validation on the homepage

| Module                          | Approximate initial attribution | Source evidence / direction                                                                                                                                                                        |
| ------------------------------- | ------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDE manifest JSON schema        |                        1.63 MiB | `lib/plugin/ide/manifest-schema.ts:1` statically imports Ajv and the full schema; load validation when installing/checking a plugin, or evaluate build-time precompilation                         |
| `js-tiktoken` cl100k vocabulary |                        1.04 MiB | `lib/ai/tokens/fallback-estimator.ts:1` statically imports the rank data; investigate loading the exact tokenizer when needed without silently changing token-count semantics                      |
| Lucide catalog JSON             |                        0.80 MiB | `lib/icons/lucide-catalog.tsx:33` imports the catalog; `lib/plugin/core/validation.ts:27` shares this rendering catalog for name checks; separate lightweight validation metadata from icon shapes |
| Companion command catalog       |                        0.57 MiB | `protocol/companion-commands.json` appears in initial chunks; investigate a compact runtime contract versus full descriptive metadata                                                              |
| Model capabilities data         |                        0.31 MiB | `lib/ai/providers/models-dev-capabilities.json` appears in initial chunks; partition/load where model selection or capability checks require it                                                    |

The initial chunk `86618-3dad073c48afd6a5.js` alone is **1.83 MiB parsed / 288.1 KiB gzip**, dominated by plugin schema/validation. Ajv compilation is deferred inside a function, but the schema import itself is eager.

Other initial modules include `ai`, multiple AI provider SDKs, KaTeX, and `html2canvas-pro`. Screenshot/export code should be reviewed at the call sites: for example, `components/share/quote-card-dialog.tsx:10` and `components/settings/subscription/usage-share-dialog.tsx:10` import `html2canvas-pro` statically.

### 2. Shiki: broad catalogs and two major versions

The analyzer attributes approximately **39.35 MiB** across Shiki and `@shikijs/*` occurrences, including **31.59 MiB** of language grammars and **5.04 MiB** of themes. These are mostly async assets, not all initial-page code.

The client output contains Shiki **4.4.3** and **3.23.0**. `pnpm why shiki` confirms the root app uses 4.4.3 while `@streamdown/code@1.1.1` brings 3.23.0. The separate docs app's 4.5.0 is not included in this main-app finding.

`lib/shiki/highlight-cache.ts:16` imports `bundledLanguages`, `codeToHtml`, and `getSingletonHighlighter` from the broad `shiki` entry; `components/ai-elements/code-block.tsx:25` imports `createHighlighter` from the same entry. Investigate a shared highlighter with explicit theme/language loading and a deliberate fallback for uncommon languages. Align versions through supported dependency upgrades rather than forcing incompatible major versions through an override.

### 3. Repeated async data and dependency copies

| Emitted content          | Observed output                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Support knowledge corpus | Two chunks, each **3.13 MiB parsed / 1.26 MiB gzip**                                |
| English messages         | Two chunks, each **2.17 MiB parsed / 0.68 MiB gzip**                                |
| Chinese messages         | Two chunks, each **2.10 MiB parsed / 0.74 MiB gzip**                                |
| ELK layout engine        | Four approximately **1.38 MiB** chunks: two copies each of **0.12.0** and **0.9.3** |

The support corpus enters via `lib/support-agent/knowledge.ts:1`. Full locale JSON imports exist in `i18n/messages.ts:47` and `lib/headless/i18n.ts:56`. The app imports ELK 0.12.0 in `lib/workflow/editor/auto-layout.ts:67`; `pnpm why elkjs` identifies Mermaid 12.0.0 as the source of ELK 0.9.3.

The analyzer also shows identical AI SDK versions under distinct pnpm peer contexts, such as `@ai-sdk/openai@4.0.78` with both `zod@4.6.5` and `zod@4.4.3`, and both contexts occur in initial chunks. Audit workspace peer alignment and installed dependency resolution.

Repeated filenames/modules establish duplicated emitted content, but this run did not establish why every copy was emitted or whether each compilation context can safely share one chunk. Inspect the compiler/layer and import boundaries before changing split-chunk rules. Do not assume all repeated output is simultaneously downloaded or that its entire size can be removed.

### 4. Development artwork is shipped and precached

The 75 files under icon `raw/`, `qa/`, or with contact-sheet names total **125,351,786 bytes (119.54 MiB)**. The completed `public/sw.js` precache list contains **all 75**. This is a confirmed PWA precache payload as well as static-export/package footprint; actual transfer depends on successful service-worker installation and cache state.

Largest categories:

- `public/icons/cognia-mobile-spots/raw/`: **100.67 MiB**.
- `public/icons/cognia-mobile-spots/png/`: **28.81 MiB**.
- `public/icons/cognia-mobile-spots/webp/`: **15.10 MiB**.
- `public/icons/cognia-mobile-spots/qa/`: **7.43 MiB**.

No literal references to the searched raw/QA/contact-sheet paths were found in `app/`, `components/`, `hooks/`, or `lib/`. This is a removal-review candidate, not proof that no dynamically constructed URL can reference them. Move confirmed development-only assets outside `public/` and explicitly exclude them from precaching. Keep the actual runtime formats that the product needs.

## Recommended implementation order

1. **Remove confirmed development-only artwork from shipping/precache.** Verify product icons, offline behavior, and export manifests; the measured candidate set is 119.54 MiB.
2. **Reduce the global initial graph.** Start with validation/schema, icon metadata, tokenizer data, and nonessential hosts; verify initial exported script totals for `/`, `/logto/callback`, and `/onboarding` plus real application startup flows.
3. **Align dependency versions and narrow Shiki catalogs.** Preserve highlighting and plugin grammar support; verify async chunk count and both light/dark themes.
4. **Investigate duplicate locale/corpus/ELK chunks.** Compare identical modules across compiler contexts and preserve locale switching, headless usage, support search, and workflow layout.

No application optimization was made in this run. These measurements are the baseline; projected savings beyond the identified static-file set need a before/after build.

## Validation and changes

- Added opt-in `build:analyze`, official analyzer dev dependency, and the gated configuration wrapper.
- Added a regression check in `scripts/build/mobile-config.test.mjs` that analysis is opt-in and preserves mobile Webpack extension handling.
- Relevant analyzer/mobile configuration checks: **5 passed**. Existing bundle-report utility tests: **9 passed**.
- Formatting and ESLint passed for the changed configuration/test files; `git diff --check` passed for the touched tracked paths.
- One pre-existing configuration test failed: `Build config must exclude services/sync-server`. It concerns the existing root/build tsconfig exclusion mismatch and was not changed as part of bundle analysis.
- The normal prebuild regenerated `lib/support-agent/support-docs.generated.json`; this generated content was included in the measured output.
- The official client report opened in `agent-browser`; the visible Parsed total matched **208.73 MB** (the analyzer labels binary MiB as MB).
- No full-project typecheck, application E2E, native installer-size measurement, or deployed-network performance test was performed.

Raw evidence: `summary.json`, `routes-and-modules.json`, `client-data.json`, `public-assets.json`, `icon-assets.json`, `precache-size.json`, `export-size.json`, and `build.log` in the preserved `.cache/bundle-analysis/2026-10-05/` directory.
