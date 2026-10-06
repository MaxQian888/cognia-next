# Next.js bundle optimization research — 2026-10-05

Start with shipping-asset cleanup, supported dependency consolidation, and small eager-import cuts. Then establish a genuinely lightweight route boundary and consolidate syntax highlighting. Change PWA precaching alongside lazy loading: the current service worker includes almost every emitted JavaScript chunk, so deferring execution alone will not substantially reduce its installation download.

The research measurements refer to the [completed Webpack baseline](../reports/next-bundle-analysis-2026-10-05.md), based on `b7a982a04` plus uncommitted work. The shared working tree continues to change. P0 was subsequently implemented at the user's request; its verification and full-build limitation are recorded below. Later phases remain proposals.

## P0 implementation and verification

The 75 authoring files were moved from `public/icons/` to `assets/icons/`, preserving the two icon-family directory structures. This removes them from Next's public export and Serwist's public scan without adding a second exclusion policy or postbuild deletion step. Runtime PNG/WebP URLs, generator inputs, and service-worker configuration remain unchanged.

The mobile icon manifest now declares `sourceRoot` for its preserved per-icon source paths. README/prompt references and all 81 QA preview image paths point to their new locations. Mobile artifact fingerprints include `assets/icons/`, preserving invalidation when authoring inputs change. Regression tests reuse the existing mobile exclusion inventory to reject authoring files under `public/`.

| Check                                            |                          Before |                                      After |
| ------------------------------------------------ | ------------------------------: | -----------------------------------------: |
| Authoring files in public/export asset inventory |                              75 |                                          0 |
| Authoring bytes in that inventory                |      125,351,786 B (119.54 MiB) |                                        0 B |
| Authoring URLs in the precache selection         | 75 in the completed baseline SW |   0 in isolated Serwist integration output |
| Preserved artwork binary hashes                  |                              74 |                               74 identical |
| Runtime PNG/WebP files                           |                             178 | 178 identical hashes, copied and precached |

The remaining moved file is QA HTML; its image paths were updated. This is a deterministic category comparison, not a timing benchmark. It clears the preregistered 119 MiB category threshold with zero inventory noise. The full export's net size, compressed installer size, and browser SW install/update behavior have not been remeasured.

Verification completed:

- `node --test mobile/scripts/mobile-assets.test.mjs scripts/build/build-sign-in-icons.test.mjs`: **18 passed, 0 failed**. The relocation and fingerprint checks were observed failing before implementation.
- Real `cwebp` encoding regenerated all eight sign-in icon mappings and both generated modules into the evidence directory, without replacing unrelated tracked outputs.
- Browser verification of the relocated QA page: **81/81 images loaded**, no broken images; search and dark-background selection work.
- Installed Next.js `recursiveCopy` and installed Serwist Next/Webpack integration, using the real production options with an isolated fixture entry/SW: **0 authoring export files, 0 authoring precache entries**; all 178 runtime assets and `offline.html` retained. This checks the actual asset pipeline, not a full application build.
- Focused ESLint, formatting, and diff whitespace checks passed. Repository i18n parity/reference checks and locale sorting checks passed.

`pnpm run build:analyze` exited **1** during prebuild: `lib/ai/agent/external/manager.ts:81` imports missing `./runtimes/codex/codex-app-server-client`. Full typecheck exited **2**, including that error and unrelated external-agent, identity-test, and push-notification errors. Full ESLint exited **1**, reporting unrelated source findings and generated iOS archive files under `dist/ios/`. These paths were not repaired as part of P0. The existing root `out/` has **not** been regenerated; do not treat it as the optimized release artifact.

Evidence lives in `.cache/bundle-analysis/2026-10-05/p0/`: `before.json` includes the experiment contract and source hashes; `source-verification.json`, `public-export-verification.json`, `public-precache-entries.json`, and `verify-public-export.cjs` preserve the asset checks; build/typecheck/lint/test logs preserve gate results. No native installer or device validation was performed. Keep the change on the strength of the deterministic asset reduction and passed focused guards; complete the release build once the unrelated build blocker is resolved.

## Targets and evidence

| Target                                            |                              Baseline | Interpretation                                                                  |
| ------------------------------------------------- | ------------------------------------: | ------------------------------------------------------------------------------- |
| Homepage HTML script references                   | 22.88 MiB; 6.36 MiB gzip; 268 scripts | Includes shared layout; excludes runtime imports and service-worker traffic     |
| Login callback script references                  |              22.75 MiB; 6.31 MiB gzip | A lightweight route currently receives almost the main app's initial payload    |
| All analyzer client chunks                        |            208.73 MiB; 59.90 MiB gzip | Includes deferred features; not the initial download                            |
| Static export                                     |                            515.21 MiB | Uncompressed files, not the compressed installer                                |
| Files referenced by completed SW precache         |         441.52 MiB; 5,334 unique URLs | Local uncompressed inventory, not measured network traffic or browser quota use |
| Authoring artwork included in export and precache |                  119.54 MiB; 75 files | Strongest identified shipping-size candidate                                    |

All sizes use binary MiB. The SW inventory contains 4,456 of 4,463 emitted JavaScript files; seven files exceed the configured compilation-asset size limit. Analyzer and filesystem inventories differ slightly and must not be mixed as identical measurements.

## Recommended experiments, in order

### 1. Stop shipping authoring artwork

Move confirmed raw artwork, QA previews, and contact sheets outside `public/`, preserving provenance and usable authoring previews. Keep runtime icon URLs intact. An alternative is a shared export policy, but it must also control precache selection before the service worker is generated: removing exported files afterward leaves broken install URLs.

Reuse the exclusion inventory and validation in `mobile/scripts/mobile-assets.mjs:21` and `:77`. Its existing checks cover replacement files, runtime references, symlinks, and stamped exports. Android already invokes it; the iOS path still needs verification. Do not run the mobile pruner unchanged on the web export because its platform-specific rules remove service-worker files.

The first candidate set is **119.54 MiB**, about **23.2%** of the baseline export. Subtracting those same files gives **395.67 MiB** of export and **321.98 MiB** of precache inventory. These are arithmetic estimates, not verified after-build results, startup savings, or compressed installer savings.

A second candidate is **29.42 MiB** of PNG outputs whose runtime counterparts already use WebP. Treat that separately:

- `components/mobile/mobile-spot-icon.tsx:103` selects 65 WebP assets and 16 PNG fallbacks through the manifest. Preserve the fallbacks.
- `lib/agent-team/avatar.ts:155` uses WebP avatars.
- `scripts/build/build-sign-in-icons.mjs:27` and `:111` still consume source PNGs for identity-worker and CLI callback derivatives. Relocate inputs and update regeneration before excluding their sources.
- Preserve manifest provenance, README references, and QA HTML relative paths. Do not delete source artwork as a shortcut.

**Verify:** rebuild the export; excluded files and SW URLs both have zero matches; all 81 feature icons and 16 avatars resolve; sign-in icon regeneration and authoring previews still work; existing asset-policy tests pass. Inspect representative icons at their actual display sizes before any additional resizing or lossy encoding.

### 2. Consolidate dependencies through compatible resolutions

**Shiki:** the root uses `shiki@4.4.3`; installed `@streamdown/code@1.1.1` requires Shiki 3 and resolves 3.23.0. The published `@streamdown/code@2.0.0` package requires `shiki ^4.4.3` and still exposes `createCodePlugin({ themes })`. Evaluate that supported upgrade first. Its incremental highlighting/cache behavior changed, so an API-compatible call alone is insufficient validation. Published registry metadata and tarball contents were inspected; repository main is not a reliable substitute for published-version evidence.

**Zod/AI SDK:** five workspace packages—`eval-core`, `provider-core`, `provider-types`, `rag`, and `router-fusion`—have broad Zod peers resolving to 4.4.3 while the root resolves 4.6.5. Actual installed paths show the same AI SDK/provider versions under both peer contexts, and both appear in initial output. Align the intended workspace Zod 4 resolution with targeted dependency changes, such as catalog-backed development dependencies alongside appropriate published peers. Then inspect deduplication. Keep legitimate Zod 3 dependencies; do not force every package onto one incompatible major.

**Verify:** inspect `pnpm why`, lockfile peer contexts, and the new analyzer output; test streaming and completed code blocks, light/dark themes, language aliases, tool/schema validation, and provider integrations. Run targeted dependency installation in a stable checkout. A broad lockfile rewrite or `dedupePeerDependents` toggle does not by itself resolve incompatible peer contexts. Savings remain unquantified until rebuilding.

### 3. Cut small, proven eager-import paths

The application already has deferred initializers and lazy features. The next useful change is to move specific expensive imports behind the operation that needs them, while retaining validation and synchronous contracts.

| Path found in the current source                                                              | Proposed experiment                                                                    | Constraint                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AppRuntime → ContextKeysInitializer → plugin-store → validation → IDE schema`                | In the already-async `scanPlugins`, load validation before validating the scanned list | Validate every manifest before accepting it; audit other eager consumers too                          |
| `PluginUpdateToaster → updater → manager`                                                     | Import its event name and type through a lightweight event contract                    | Reuse an existing contract if available; moving one import may not eliminate other manager paths      |
| `validation → lucide-catalog → full SVG catalog`                                              | Generate name/alias metadata separately from SVG nodes                                 | Preserve PascalCase/export names and canonical-name compatibility                                     |
| `AppRuntime → useClaudeChat → controller → send-options → build-options → fallback-estimator` | Evaluate deferring the async send-options assembly at the actual send operation        | Keep the chat provider alive across navigation and preserve trust, account, PII, and readiness checks |

Relevant source locations are `stores/plugin-runtime/plugin-store.ts:30` and `:964`, `lib/plugin/core/validation.ts:27` and `:68`, `components/plugins/plugin-update-toaster.tsx:21`, and `hooks/chat/claude-chat-send-options.ts:6`.

The tokenizer's **1.04 MiB** vocabulary is an initial contributor, but `estimateFallbackTokens` is synchronous and serves token budgets as well as presentation. Do not replace exact tokenization with a characters-per-token heuristic or make a loader asynchronous without updating every dependent contract. Moving its containing async operation is the safer first experiment.

Two serialization probes give useful bounds, without establishing compiled savings:

| Probe                                               | Original JSON | Candidate JSON |                Difference |
| --------------------------------------------------- | ------------: | -------------: | ------------------------: |
| Lucide full catalog → names and export aliases only |     839,806 B |      217,623 B | 622,183 B; 132,809 B gzip |
| IDE schema → remove schema annotations              |   1,703,042 B |    1,223,048 B | 479,994 B; 102,787 B gzip |

The Lucide candidate retains names and export aliases; the much smaller canonical-only list is not a compatible replacement. Split the existing generator's output rather than hand-maintaining a second catalog. Rendering still needs SVG nodes when icons are displayed, so the difference is not automatically an export-size saving.

For the schema, preserve the full authoring contract and generate a separate runtime artifact from `packages/plugin-sdk/scripts/generate-ide-contract.mjs` if this experiment proves useful. The probe removed 4,204 annotations only at schema positions; it did not prove validation equivalence or check all diagnostic consumers. Prefer deferred loading before stripping metadata. Ajv standalone compilation is another experiment, but this project has custom formats and generated validators can grow; do not assume it is a guaranteed reduction.

**Verify:** focused plugin-store/validation/icon/token/send-flow tests, invalid manifests and alias cases, provider-authoritative token usage, unchanged PII/trust ordering, and full first-load script inventories after rebuilding. The traced paths are static AST paths, not a proof that cutting one edge removes every consumer; the analyzer is the final size check.

### 4. Give lightweight routes a real module boundary

`components/runtime/lightweight-route-shell.tsx` currently chooses which subtree to render. The root still statically imports `AppRuntime` and its broad dependency graph. That explains why `/logto/callback` receives nearly as much initial JavaScript as `/`.

Start with login callback/status/overlay route families and a minimal shared root. Put the heavy application runtime behind a client module boundary or a nested route-group layout that is absent from lightweight routes. Route groups can preserve URLs. Keep one common root where practical: switching between separate root layouts introduces full page loads.

Do not move the active chat controller into a page that unmounts on navigation. Preserve global streaming, account lock/auth callbacks, platform-specific overlays, theme/locale providers, and error boundaries. Merely setting `ssr: false` or conditionally rendering a statically imported component is not sufficient. Next also documents limitations when dynamically importing a Client Component from a Server Component; use a supported client-side boundary and confirm emitted scripts.

**Verify:** production first-load inventories for `/logto/callback`, `/status`, overlays, `/`, and `/onboarding`; auth redirect/return, direct navigation, static-export URLs, route transitions during streaming, and desktop overlay startup. Run static-export and runtime-wiring review after implementing this boundary.

### 5. Share a narrower highlighter without removing language support

The analyzer attributes approximately **39.35 MiB** to Shiki-related occurrences, mostly deferred language/theme assets. This is not a removable-byte promise.

After the supported dependency upgrade, extend `lib/shiki/highlight-cache.ts` into the shared runtime for HTML output, token output, and Streamdown's `CodeHighlighterPlugin` interface. Use `shiki/core` with the existing `one-light` and `one-dark-pro` themes from `lib/chat/code-theme.ts`. Replace broad all-theme entry points where feasible.

Keep one lazy language registry with aliases and embedded-language dependencies, plus plugin TextMate grammar support. Preserve the existing weighted cache, exact-source keys, in-flight deduplication, and serialization gate. A local Shiki 4.4.3 API probe passed core initialization, the two themes, TypeScript dual-theme tokens, and a synthetic plugin grammar; it does not establish complete UI or bundler compatibility.

Published `@streamdown/code` configuration does not directly accept a custom language/highlighter implementation, so simply passing fewer themes does not eliminate its broad language imports. A custom adapter through Streamdown's documented plugin interface is a separate, larger change. Test incomplete fenced code and final output as well as ordinary highlighting.

Preserving all-language offline support means shipping the language assets somewhere. Lazy loading changes when they load, not necessarily their total distribution footprint. Keep the Oniguruma/plugin-grammar compatibility decision separate from a JavaScript regex-engine migration.

**Verify:** streaming/final rendering, aliases, embedded languages, both themes, unknown-language fallback, plugin grammar registration, concurrent highlighting, cache eviction, offline language availability, and total/initial chunk sizes.

### 6. Make PWA caching agree with loading boundaries

Installed Serwist 9.5.12 scans `globPublicPatterns` and appends those files as `additionalPrecacheEntries` after the normal maximum-size filtering and manifest transforms. Thus the configured 2 MiB cap and Webpack `exclude` do not remove large automatically scanned public files. The completed manifest confirms this with large Monaco workers, OCR cores, and contact sheets. Control public selection with tested public glob patterns or a complete explicit public manifest with content hashes.

Reuse `app/sw.ts:41–83` for offline fallback and runtime caching. Define the required offline startup set, cache optional features when used, and provide deliberate offline preparation only for features promised to work before their first online use. Select compiled assets using entry/chunk relationships rather than unstable hashed filenames.

Do not blindly exclude every async chunk: that can break offline locale switching, editors, plugin operations, and code highlighting. Also, JS precaching alone does not make every route's HTML/app data available offline. The relevant offline architecture is ADR 0027.

Two follow-ups need product/platform evidence:

- **Monaco, 24.38 MiB:** all 151 runtime files match installed 0.57.0 byte-for-byte, so duplicate-looking worker paths are not proven stale files. Web defaults to a CDN unless `NEXT_PUBLIC_MONACO_VS_PATH` is configured, while Tauri uses local assets. Verify deployment configuration, choose a consistent local/offline loader strategy, and trace worker requests before trimming anything.
- **OCR, 11.41 MiB:** the existing copy step already includes only selected LSTM cores and a worker. Preserve CPU fallbacks. Local worker/core paths do not establish fully offline OCR because language data defaults to a CDN unless configured. Separate optional web caching from native packaged assets.

**Verify:** fresh install and update from an older deployment, limited cache space, cached and unvisited offline routes, locale switching, optional-feature use before/after offline preparation, and worker startup. Measure page requests separately from SW installation. Capacitor disables Serwist and needs its own packaged-asset checks.

## Follow-up work, after the first measurements

- **Production capability gating:** `lib/boot/capabilities.ts:30` forces the eager profile outside development. Setting `NEXT_PUBLIC_COGNIA_BOOT_PROFILE=main` alone will not change production behavior. Reuse `ensureBootCapability`, route activation, and `lib/boot/startup-probe.ts` for any experiment. Background connectors, scheduled jobs, plugin readiness, and recovery may require initialization without visiting their UI; changing all initialization to route-only would be a regression.
- **Repeated locale/support corpus chunks:** trace compiler layers and importers before changing `splitChunks`. Preserve headless locale access, language switching, and support search. Similar emitted modules do not prove that every copy can share one runtime chunk.
- **ELK:** Mermaid 12 requires `elkjs ^0.9.3`, which does not include the root's 0.12.0. Do not force an override or replace Mermaid with a reduced build that silently loses diagram types. Investigate repeated output within the same version first.
- **Other catalogs and export tools:** companion commands, model capability data, and static screenshot-library imports are secondary candidates from the baseline. Their loading contracts still need individual investigation; no saving is assigned here.

Package extraction, enabling React Compiler, migrating the build to Turbopack, or introducing a microfrontend architecture is not the first experiment for these measured payload sources.

## Execution and acceptance

Use independent changes so that regressions and benefits remain attributable:

1. Shipping-asset and matching precache policy → verify exported paths, generated derivatives, asset tests, and byte inventories.
2. Supported dependency consolidation, with Shiki and Zod changes separable → verify peer resolution, feature tests, and duplicate modules.
3. Plugin validation/icon metadata import boundaries → verify semantics and initial script reduction.
4. Lightweight routes and shared highlighting → verify lifecycle/platform behavior and both initial/total output.
5. Broader feature caching and production boot deferral → verify explicit offline and background-operation contracts.

For each implemented experiment, preserve a stable source/dependency snapshot, run `rtk pnpm build:analyze`, and compare the same routes and measurement scripts. Record initial script references, all client JS, export bytes, precache bytes, and compressed delivery/installer bytes separately. Do not compare a dirty-tree after-build against this baseline as if unrelated changes were controlled.

Use existing `lib/perf/` and boot probes to measure time to usable UI and long tasks. Test production cold/warm startup with service-worker state explicitly labeled, plus desktop/mobile paths affected by the change. A smaller aggregate bundle does not establish faster startup. Run focused tests and required lint/type/static-export checks for edited code; coverage is not requested. No optimization is accepted solely because a treemap looks smaller.

## Research artifacts and limitations

Document formatting passed. Running `pnpm exec prettier` triggered the workspace's automatic install and postinstall hooks, including generated package/type outputs. No dependency upgrade was intentionally applied as an optimization, and concurrent working-tree changes were not reverted. Treat current installed state separately from the preserved build snapshot; rerun resolution checks when implementing the plan.

Local scratch evidence is under `.cache/bundle-analysis/2026-10-05/` (Git-ignored): `research-assets-pwa.md`, `research-upstream.md`, `research-import-paths.json`, and `research-data-probe.json`, alongside the original analyzer HTML, extracted data, and build log. The static import probe does not evaluate symbol-level tree shaking or external package internals. Serialization probes do not establish validation parity or compiled savings. No new optimized build, end-to-end benchmark, or installer measurement has been performed.

## Sources

- [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading) — supported client boundaries and dynamic-import limitations.
- [Next.js route groups](https://nextjs.org/docs/app/api-reference/file-conventions/route-groups) — URL-preserving organization and multiple-root-layout navigation behavior.
- [Streamdown code plugin](https://streamdown.ai/docs/plugins/code) and [published 2.0.0 metadata](https://registry.npmjs.org/@streamdown/code/2.0.0) — supported plugin surface and released dependency constraints.
- [Shiki bundles](https://shiki.style/guide/bundles), [language loading](https://shiki.style/guide/load-lang), and [regex engines](https://shiki.style/guide/regex-engines) — explicit imports, lazy language support, and engine compatibility.
- [pnpm dedupe](https://pnpm.io/cli/dedupe) and [peer dependency settings](https://pnpm.io/settings/peer-dependencies) — resolution and peer-context behavior.
- [Serwist Next configuration](https://serwist.pages.dev/docs/next/configuring), [maximum precache file size](https://serwist.pages.dev/docs/build/configuring/maximum-file-size-to-cache-in-bytes), and [chunk selection](https://serwist.pages.dev/docs/webpack-plugin/configuring/chunks) — configuration surface; installed 9.5.12 source establishes public-entry filtering order.
- [Ajv standalone validation](https://ajv.js.org/standalone.html) — generated validators and custom-format requirements.
- [Mermaid layouts](https://mermaid.js.org/config/layouts) — layout-engine capability preservation.
