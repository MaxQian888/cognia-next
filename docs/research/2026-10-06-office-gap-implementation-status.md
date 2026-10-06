# Office gap implementation: completed changes and blocked engine integration

Date: 2026-10-06. This follows the comparison in [the research report](./2026-10-06-dsh-libreoffice-kit-cognia-comparison.md) and the subsequent request to implement missing capabilities while reusing existing components. It is not a claim that the full Office engine integration is finished.

**Current dependency ownership (latest user correction):** the Office engine belongs to an optional plugin and must be installed/loaded on demand, not included with the default sidecar or application. The temporary sidecar installation described later was removed using normal pnpm removal, which passed policy checks and exited 0. Sidecar manifest, lockfile and workspace policy now have no diff; the engine no longer resolves from sidecar dependencies. The previous pending sidecar Koffi build-policy proposal is superseded and must not be applied.

## Latest implementation: plugin-owned on-demand dependency lifecycle

The subsequent request to implement plugin loading is now represented by a real host-backed path. `cognia-office` declares `nodeRuntime: { directory: "runtime", entry: "probe.mjs" }`; the plugin owns the exact `@deepseek-ai/libreoffice-kit@0.1.5` dependency, pnpm lockfile and local installation policy. The policy retains the 24-hour release age and explicitly denies the exact Koffi build script. The engine is absent from root/sidecar dependencies and from shipped plugin resources. Packaging stages only four small runtime source/manifest/policy files, using the existing frontend builder and atomic native plugin seeder.

`PluginContext.nodeRuntime` exposes status, prepare, cancel, probe and remove through the existing plugin API gateway. `crates/cognia-plugin-runtime/src/node_runtime.rs` validates the installed declaration, rechecks existing permissions, stages a frozen-lockfile installation, and publishes a private runtime cache keyed by account, plugin and source fingerprint. Installation is bounded and cancellable; disabling/unloading the plugin, changing accounts or revoking permission terminates active work. No caller-provided command, source directory or document path is accepted. The host selects an existing compatible Node and exact pnpm; it does not install a package manager.

The existing workbook preview now has localized runtime controls. The Agent tool `office_engine_runtime` exposes the same explicit actions. Neither plugin activation nor preview mounting inspects, downloads or imports the engine. Status reads metadata; prepare installs; probe dynamically imports the installed module in a short-lived Node process. Errors remain visible and can be retried. Removal deletes only this plugin's prepared cache. The UI and tool do not automatically run probe after installation.

This completes dependency preparation and module discovery, **not document execution**. A successful probe reports `documentsSupported: false`. Real conversion, recalculation and rendering remain subject to the separate confined document-execution work described below. macOS ARM64 plugin-local installation and module discovery have passed a real frozen-lockfile smoke; Windows/Linux and packaged-app relocation are not yet validated. The later historical installation failures are retained to explain the investigation, not to describe the current plugin-local package result.

Relevant implementation: `plugins/cognia-office/runtime/`, `plugins/cognia-office/src/engine-runtime.ts`, `lib/plugin/api/node-runtime-api.ts`, `types/plugin/plugin-node-runtime.ts`, `crates/cognia-plugin-runtime/src/node_runtime.rs`, and existing build/seeding helpers. SDK contract mirrors and colocated tests accompany these changes. The shared branch advanced again during this work; the latest observed HEAD is `4482de7b84889d0b46851210578853875d20ebc3` on `dev`. Concurrent unrelated changes remain untouched.

Desktop discovery preserves the canonical builtin UI when the runtime's registry declaration, staged catalog version, standard native installation path and recorded builtin install origin all match. This prevents the runtime companion from replacing the frontend plugin identity under a permissive local-plugin signature policy. Other local plugins retain normal signature verification. Runtime changes shipped in a future release must bump the plugin version because the existing seeder upgrades by version.

Focused checks passed: Office controller/activation/preview **34 tests**, probe **8 tests**, SDK/permission/manifest **482 tests**, plugin manager **258 tests**, runtime host **12 tests**, native API permission checks **5 tests**, packaging scripts **15 tests**, seeder **21 tests**. Generated SDK freshness, selection-action parity, focused ESLint/Prettier and diff checks passed. Generated browser/plugin staging was rebuilt and contains no installed Office engine.

The full root TypeScript check now **passes**: `node --max-old-space-size=16384 node_modules/typescript/bin/tsc --noEmit --pretty false` returned exit 0, with empty `/tmp/cognia-office-typecheck-recheck.log`. The three previously reported concurrent issue/delegation errors were fixed by their owners and are no longer blockers. `/tmp/cognia-office-typecheck-final.log` is a historical failed run. No coverage or full application build was run.

The **actual Rust host lifecycle smoke passed in 279.11 seconds** on macOS ARM64: status missing → explicit asynchronous prepare → prepared → explicit probe of API 0.1.5 → persisted probe status → remove → missing. This used the real official locked packages in a temporary private host cache, not fake dependency modules. The first attempt revealed an incomplete optional native download despite pnpm's successful exit; normal `--fetch-timeout=900000 --fetch-retries=0`, bounded by the host's overall deadline, resolved acquisition. Bounded installation diagnostics are retained in the plugin host cache. The successful test removed its cache. Root and sidecar resolution both still return `MODULE_NOT_FOUND` for the kit.

The smoke is opt-in (`node_runtime::tests::real_office_runtime_lifecycle`, ignored in ordinary runs) because it downloads the optional package. It asserts module metadata and `documentsSupported: false`; it does not invoke `dsoffice`, create a converter, open a document or prove native rendering. Installed-app GUI behavior, Windows/Linux execution, fonts and conversion confinement are not claimed by this test.

## Scope and working tree

Implementation began on `dev` at `2f3a9b1d1f7633ceb77b5f3bb0a741376d364966`. The shared branch subsequently advanced to `9449c4dd2a6e3096f7103961a045832b2416e082`. Other sessions are editing Squad/companion contracts, generated assets, translations and support documentation. Those changes were preserved. No commit, push, deployment, service startup or system configuration change was performed for this task.

The earlier authoring/loss-reporting phase changed:

- `plugins/cognia-documents/src/docx.ts`, its colocated test and `plugin.json`.
- `plugins/cognia-presentations/src/model.ts`, `pptx.ts`, `preview.ts`, `tools.ts` and their four colocated tests.
- This status document. The original comparison report remains a historical snapshot, not a description of these newer edits.

## Delivered behavior

### Presentations

The existing deck model now accepts optional named chart `series`, while retaining `values` as the first series for existing schema-v1 consumers. Agent tool schemas, model validation and the existing browser preview accept the same representation. Supported charts retain all series, including negative values, instead of importing only the first one.

The existing PPTX writer now emits native DrawingML table and chart frames. Supported charts use native clustered-column chart parts, cached category/value data, relationships and an editable embedded XLSX workbook. The workbook uses the already installed ExcelJS dependency; no dependency was added. Tables are emitted as native table cells instead of individual text rectangles.

The supported editable chart subset is shared-category clustered columns. Other chart types, sparse/inconsistent data, unsupported chart styling/analytical options, table formatting and source workbook links/formulas produce explicit loss information. This does not claim preservation of arbitrary PowerPoint charts or all table layout properties.

### Documents

The existing DOCX importer now detects nine additional loss categories: inline formatting, paragraph formatting, table formatting, nested tables, styles, custom numbering, equations/symbols, comment metadata and comment anchors. It also detects custom page setup in a single-section document. Baseline comparisons reuse the actual existing DOCX writer rather than maintaining another copy of its default formatting specification.

Mixed ordered/bullet list semantics are preserved per level, including level overrides. New loss categories flow through the existing `importedFeatures`, preview and export safeguards. Matching English and Chinese feature labels are in the plugin's existing manifest translation dictionaries. No TSX or split application translation sources were changed by this task.

Comment dates discarded on reimport are reported even when the input originated in Cognia. The change improves honesty about loss; it does not turn the subset model into a lossless Word editor.

## Usage of completed changes

Enable the existing Documents or Presentations plugin and use its normal import, preview, edit and export actions. No separate editor or configuration screen is required.

For a chart created through the existing presentation tools, provide `labels`, the legacy first-series `values`, and optional `series: [{ name, values }, ...]`. All series must have the same number of finite numeric values as categories, and legacy `values` must match the first series. Export through the existing PPTX action to retain native chart data. Existing single-series artifacts remain supported.

On DOCX import, review the existing loss report before continuing with model-based editing or export. Keeping the original outside this editable model remains necessary for unsupported content. This task has not connected persistent original retention to a new conversion service.

## Engine package verification

The official npm registry publishes `@deepseek-ai/libreoffice-kit@0.1.5`, MPL-2.0, Node `>=22.19.0`. Its platform engine dependencies are pinned to `0.1.5`. The official entry and macOS ARM64 tarballs were downloaded under `/tmp` and verified against the registry SHA512 integrity values. They were not executed as a document engine.

The entry package is 104,240 compressed bytes / 349,150 unpacked bytes. The macOS ARM64 engine is 67,261,855 compressed bytes / 153,160,461 unpacked bytes. These are this inspected release's metadata, not estimates for all platforms or the final application installer.

The published declarations expose `createConverterFactory`, `render`, `convert`, `recalculate`, `renderImages`, AbortSignal and disposal. Image selections include pages, sheet and range, with DPI/page/pixel/dimension bounds. Results include backend/font diagnostics; image manifests include source hash, image dimensions and selection metadata. There is no precise conversion progress callback or OS sandbox launcher supplied by the library. An entire worker process would need host confinement.

The inspected conversion matrix is DOC/DOCX/ODT to PDF/DOCX/ODT/TXT; XLS/XLSX/ODS to PDF/XLSX/ODS/CSV; PPT/PPTX/ODP to PDF/PPTX/ODP. Macro-enabled filename extensions are not listed. PDF is additionally supported for image rendering. Image page numbers are one-based; worksheet rendering forbids `pages`, and a range requires an exact sheet. Multi-sheet CSV also requires an exact sheet. Defaults are 100 images, 144 DPI and 16,777,216 pixels per image, with DPI bounded to 24–600.

Font configuration is not a full font-resolution audit trail: native engines may use OS-managed fonts, and binary DOC/XLS/PPT return empty `missingFonts` even when that cannot establish absence of missing fonts. A configuration hash alone cannot prove identical font bytes or layout. Converter deadlines begin after acquiring its serial slot, so a host queue must separately bound waiting time. These limits must appear in any future capability and reproducibility contract.

The earlier report's repository manifest/README was `0.1.3`; this independent `0.1.5` tarball inspection resolves the published API question without assuming those source versions are identical. Official sources: [npm registry metadata](https://registry.npmjs.org/@deepseek-ai/libreoffice-kit/0.1.5), [repository](https://github.com/deepseek-ai/dsh-libreoffice-kit), [packaging documentation](https://github.com/deepseek-ai/dsh-libreoffice-kit/blob/master/docs/packaging.md).

## Current execution reassessment

Rechecked at `4482de7b84889d0b46851210578853875d20ebc3`. Dependency resolution and full root TypeScript are resolved. The remaining hard prerequisite is a verified executor for untrusted document processing with bounded filesystem reads/writes, network disabled, resource limits and cancellation of the complete child tree. The latest request explicitly preserves these requirements; an unconfined worker is not an authorized substitute.

| Candidate                               | Current source evidence                                                                                                                                                                                                                                                                | Consequence for Office jobs                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS one-shot / interactive OS backend | `crates/cognia-exec-sandbox/src/sbpl.rs:40-44` emits global `file-read*`; `macos.rs:451-453` explicitly says `readable` does not bound reads; `launcher.rs:210` reuses that base                                                                                                       | Existing read scopes cannot prove an Office-only input/runtime/font allowlist. Passing a smaller list or denying several credential folders does not establish it.             |
| Existing sandbox health result          | `crates/cognia-exec-sandbox/src/types.rs:230-232` defines `confined` as successful execution plus refusal of an out-of-scope **write**                                                                                                                                                 | `confined: true` is insufficient evidence of bounded reads or an Office-specific network/resource policy.                                                                      |
| Windows runner                          | `crates/cognia-sandbox-runner/src/lib.rs:300-305` rejects `network: off`; `windows.rs:173-181` propagates unavailable                                                                                                                                                                  | It cannot satisfy offline document execution today. Native kit support does not fix the host boundary.                                                                         |
| Linux bwrap                             | `linux.rs:554-558`, `609-623`, `665` provide namespaces, read/write binds and network isolation; `578` additionally mounts broad system directories including `/opt` and `/etc`                                                                                                        | A useful implementation base, but the generic profile is not a verified per-document read closure. A dedicated Office policy/image and real Linux validation are still needed. |
| E2B microVM adapter                     | `plugins/e2b-sandbox/src/microvm-exec.ts:64-72` requires a workspace created with network off; `181-187` reports absent CPU/memory/process attestations; `283-287` rejects requested CPU/memory ceilings                                                                               | A shared, network-enabled VM is not a drop-in substitute. A dedicated offline VM with supported resource bounds would need additional integration and validation.              |
| Existing container implementation       | `crates/cognia-external-agent/src/container_backend.rs:1736-1747` supports mounts, resource limits, network mode, capability drops and read-only rootfs; `1365-1395` shows the current agent runner has different defaults. Docker client is behind `container-exec` (`Cargo.toml:27`) | Reuse these primitives with an Office-specific immutable job spec; do not change general agent/deployment configuration. It is not already an Office converter.                |
| New plugin Node runtime                 | `crates/cognia-plugin-runtime/src/node_runtime.rs:868` launches the prepared entry as a normal child; `probe.mjs` validates a metadata-only operation                                                                                                                                  | Installation, timeouts and permission grants do not make this a confined document worker. Extending the probe to open user files would bypass the missing boundary.            |

No earlier failing Seatbelt probe was repeated. Earlier approved probes with scoped system reads aborted `/bin/echo` with exit 134; that remains historical evidence of one unsuccessful profile, **not proof that strict macOS isolation is impossible**. This pass relies on current source behavior. No sandbox configuration was broadened, no documents were executed, and no deployment security audit was resumed.

Read-only local capability inventory found Docker and Lima executables. A bounded server-version check forced to the local Unix Docker socket exited 1 and did not establish a usable daemon. It did not inspect remote Docker contexts, start a VM/container/service or change machine configuration. Binary presence is not a validated alternative executor.

The public `nodeRuntime` lifecycle is real and tested. Public document conversion/rendering endpoints remain absent. The remaining conversion job service, provenance, font handling and UI integration are ordinary unfinished engineering work after the executor choice; they are not each independent OS impossibility claims.

## Full requirement status

| Requirement                                                           | Current status and completion boundary                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Office parsing/import and DOCX/PPTX/XLSX editing/generation           | Existing plugin subset models remain usable; no claim of lossless arbitrary Office round-tripping or newly added legacy/ODF support |
| Fix first-series PPTX import within supported model                   | **Implemented** for clustered columns with shared categories                                                                        |
| Native PPTX table/chart export                                        | **Implemented** with native parts and editable embedded chart workbook; native-engine visual fidelity unverified                    |
| Honest DOCX subset loss reporting                                     | **Implemented**, including single-section setup and nine new categories                                                             |
| Published engine version/API/license verification                     | **Completed** for 0.1.5 entry and macOS ARM64 package metadata/types                                                                |
| Plugin-owned dependency; no default engine bundle                     | **Implemented** with lock/policy and four small runtime source files; root and sidecar do not resolve the kit                       |
| Dynamic installation/loading lifecycle                                | **Implemented and real-host tested**: status, prepare, explicit probe, cancel, remove; metadata probe is not conversion             |
| Runtime SDK, permission persistence, Agent tool and workbook controls | **Implemented**, including native discovery companion identity and cleanup on unload                                                |
| Existing PDF viewer and DOM/browser artifact capture                  | **Already usable**; they remain distinct from original Office layout rendering                                                      |
| Original Office and writer-produced file rendering                    | **Not implemented**; verified confined document executor is prerequisite                                                            |
| Office → PDF and general Word/Calc/Impress format conversion          | **Not implemented**; worker, job orchestration and output validation still needed                                                   |
| Page/slide/sheet+A1 PNG and manifest                                  | **Not implemented**; existing sheet value reads/UI screenshots are not this capability                                              |
| Optional file-level Calc recalculation/cache refresh                  | **Not implemented**; existing model-level `formula-eval` and XLSX cached-result writer remain usable                                |
| Font directories/fallback/missing-font/reproducibility UI             | **Not implemented** for engine jobs; existing system/CSS fonts do not prove CJK Office layout or file font embedding                |
| Persistent original/source-version and result attachment              | **Not implemented for engine jobs**; reuse session-assets hashes/revisions and artifact optimistic version/history checks           |
| Conversion queue, cancellation, timeout and temporary resources       | **Not implemented for document jobs**; dependency-install queue/cancellation is complete but does not substitute for it             |
| Conversion-specific SDK/Agent methods and preview/export settings     | **Not exposed**, pending a working provider; current lifecycle methods are not conversion stubs                                     |
| Desktop/headless real document conversion                             | **Not validated or delivered**; desktop native dependency lifecycle is tested, gateway supports headless structurally               |
| Web/mobile forwarding of document jobs                                | **Not implemented**; use authenticated host forwarding later, not Linux Node WASM in the browser                                    |
| Windows/Linux runtime install/load and packaged relocation            | **Unverified**; no passing cross-platform or signed packaged-app claim                                                              |
| Chinese typography, pagination and golden rendering comparisons       | **Unverified**; deterministic model/ZIP tests do not establish rendered fidelity                                                    |

## Minimal next implementation and decision

**Recommended: choose a Linux execution host or an optional dedicated container/VM backend for Office first.** This is an architectural recommendation from the current code, not a verified operating environment. It preserves optional plugin ownership and avoids modifying the macOS global sandbox or deployment runner defaults. The minimum decision is whether an existing Linux host can be used, or whether an optional local container/VM dependency is acceptable. No deployment should be reconfigured implicitly.

1. **Establish the actual executor.** Reuse the container API / bwrap machinery, but construct an immutable Office job policy: an empty job workspace; pinned runtime and selected font files read-only; selected input copied into the job; writable output/profile/temp directories only; network off; bounded memory/process/time; whole-child-tree cancellation; owned cleanup. Do not mount the user's home, the general project workspace, host sockets or a general purpose shared VM workspace. Installation can use network during explicit preparation; document execution must use the prepared, offline runtime. Validate the real platform with harmless allow/deny fixtures before opening Office documents. The existing generic `confined` boolean cannot replace these checks.
2. **Implement the file worker and job service together.** Reuse the existing plugin gateway and prepared dependency generation. Bind account/plugin/session/source hash/source revision and distinguish original bytes from writer-produced bytes. Validate input/target format, exact sheet/A1 or one-based page selection, output dimensions/byte limits and font options before queueing. Bound queue waiting separately from execution. Run `render`, `convert`, `recalculate` and `renderImages` only through the approved executor; validate returned paths, hashes, MIME, image count/dimensions and manifest before storing assets. Wire AbortSignal plus a host kill deadline and cleanup; publish no result after cancellation or stale source revision.
3. **Connect existing product surfaces.** Keep the current editors. Add an explicit original-file preview/export choice to their toolbars; reuse the PDF plugin viewer and artifact image renderer. Store original input and output as session assets and use artifact owner/version checks for updates. Show engine/font/backend diagnostics and whether preview came from original or regenerated bytes. Expose conversion Agent tools only after the backend passes real execution tests. No rendering on every edit.
4. **Validate the actual outcomes.** Render DOCX/PPTX/XLSX including Chinese text, supported native charts/tables, page ranges and exact sheet+A1 ranges; compare deterministic golden images using pinned font bytes. Recalculate formula fixtures and reopen outputs to verify cached results. Test queue timeout, cancellation during conversion, plugin unload, account switch, stale revision, output limits and cleanup. Then validate packaged installation/relocation and each supported platform. Windows/macOS native can remain explicitly unavailable until their own boundary passes.

**Alternative if local native macOS is mandatory:** prioritize a dedicated strict executor before Office conversion. ADR-0028 records App Sandbox plus XPC as a possible successor, not a delivered solution. That option needs decisions about a signed helper/entitlements, bundled runtime access and selected input/font transfer, followed by actual isolated helper tests. Do not repeat the already failed SBPL profile or reinterpret broad reads as the requested allowlist.

**E2B is not presently the smallest substitute:** its current adapter needs additional resource-limit support and a dedicated offline instance/image; using it also changes document placement to a remote service. That requires an explicit backend/data-location choice. No remote sandbox was provisioned in this task.

This reassessment changes documentation only and completes the requested typecheck revalidation. It adds no callable unfinished conversion interface, does not start local services or remote jobs, and leaves all unrelated work intact.

## Reuse points for resuming work

Use existing `plugin_api_invoke` and `plugin_api_invoke_for_state` in `crates/cognia-plugin-runtime/src/api_bridge.rs`; the latter is already used by headless/companion. Do not create an unrelated daemon or expose arbitrary feature-call transport. Enforce the existing filesystem read and write permissions on the native boundary as well as the frontend.

Original persistence is **not entirely absent**: `lib/db/session-assets.ts` already provides `putSessionAsset`/`getSessionAsset`, content hashes, revisions, quotas and ownership references. This corrects any overly broad reading of the original comparison. `files-api.ts` attachment handles alone are ephemeral, but the persistent session asset system should be reused. `artifact-api.ts` already checks owner and expected version and saves history. New jobs must bind source identity/hash/version and cannot trust client-provided ownership without validation.

Reuse existing plugin writers for generated bytes, preserve original-byte and model-generated-byte provenance separately, reuse PDF.js for output viewing and keep `artifact_capture` for UI capture. Do not rerun the engine on every cell edit. First resolve a validated constrained executor and dependency installation under unchanged policy; only then expose a real provider and complete its SDK, Agent and UI path.

## Earlier authoring validation and remaining rendering limits

- Documents: exact-path Jest, **4 suites / 99 tests passed**; edited TypeScript ESLint, Prettier and diff whitespace checks passed.
- Presentations: exact-path Jest, **9 suites / 81 tests passed**; all eight edited files passed ESLint, Prettier and diff whitespace checks. Targeted strict TypeScript checks for model/PPTX and their tests passed.
- An earlier presentation/SDK type check exhausted the default approximately 4 GB Node heap. The later full root check with a 16 GB heap passed, as recorded above. Unrelated copied test snapshots under `.cache/commit-reports` were accidentally matched by an initial broad Jest filter; the real plugin suites were rerun using explicit paths and passed.
- No coverage was requested or run. No whole-repository lint/build result is claimed.
- A generated two-slide Chinese chart/table fixture exists at `/tmp/cognia-native-chart-table.pptx` for a future engine smoke. It has **not** been rendered by LibreOffice, PowerPoint or this kit. ZIP/model tests cannot establish pagination, Chinese font metrics or native Office visual fidelity.
- No actual DOCX/XLSX/PPTX engine conversion, file-level recalculation, page/range rendering, confined engine cancellation or packaged installation test passed in this task. These remain required before treating the backend as available.

The integration is incomplete for the concrete reasons above. The completed authoring/loss-reporting changes are independently usable; they do not substitute for the missing file-engine path.

## Historical dependency installation investigation (superseded by plugin lifecycle success)

The following chronology records earlier failures and the later user correction. Its intermediate "remaining blocker" statements are historical; the current dependency lifecycle succeeds, as recorded at the top of this document.

At the user's subsequent explicit installation request, the normal sidecar workspace path was checked again. The repository's current `sidecar:install` command is `pnpm --dir sidecar install`; the sidecar has its own `pnpm-workspace.yaml`. Using that workspace context loads its existing exclusions. The earlier `--ignore-workspace` invocation did not use the same context.

`pnpm --dir sidecar add --workspace-root --save-exact @deepseek-ai/libreoffice-kit@0.1.5` passed the existing supply-chain policy check without modifying release-age settings or exclusions. Normal access to the existing pnpm store was approved through the tool. Resolution reported 18 packages to add, but downloading the official `libreoffice-kit-darwin-arm64-0.1.5.tgz` failed with error 23, `TimeoutError: The operation was aborted due to timeout` after pnpm's normal retries.

A second invocation changed only the per-command network timeout to `--fetch-timeout=300000`. The same official tarball timed out again after five minutes; subsequent automatic retries were interrupted. No mirror, alternate manager, direct tarball installation, local-store injection, policy override or OS isolation relaxation was used.

Final check: no diff in the sidecar manifest, lockfile or workspace policy, and no root lockfile diff from this installation attempt. The dependency is not declared, and neither the entry module nor the native engine resolves through the sidecar's public dependency path. Some downloaded packages remain in pnpm's cache, but that is not a completed installation. No module-loading success or document-engine execution is claimed.

The remaining installation blocker is now **official native tarball download timeout**, not minimum release age. A future normal retry can use the five-minute timeout once registry connectivity is healthy; no new supply-chain exception is indicated by this result. The separate strict macOS confinement blocker for actual conversion is unchanged.

### Connection diagnosis and successful package transfer

The next authorized diagnostic used only official URLs and bounded reads. Outside the task's network-restricted sandbox, registry metadata returned HTTP 200 in 1.38 seconds. The tarball HEAD returned HTTP 200 with byte ranges supported. A 16 KiB range returned HTTP 206, `Content-Range: bytes 0-16383/67261855`, in 1.07 seconds with no redirect. The same bounded request through Node succeeded in 2.73 seconds. A size-capped ordinary GET returned HTTP 200 and stopped at the size guard rather than downloading the package. No proxy credentials or network/system settings were read or modified.

One final normal pnpm attempt used `--fetch-timeout=900000 --fetch-retries=0`. It successfully downloaded the native package and recorded `@deepseek-ai/libreoffice-kit` at exact version `0.1.5` in `sidecar/package.json` and `sidecar/pnpm-lock.yaml`. The lockfile adds 36 package records, including optional platform records, but structural comparison confirms every pre-existing package, snapshot and importer dependency remains unchanged. There was no AI SDK version refresh or root lockfile change. The native package's lock integrity matches official registry metadata.

Actual module checks passed without document execution: importing the public entry and calling `discoverRuntime()` reports version `0.1.5`, backend `native`; importing the prebuilt Koffi module reports `3.1.1`. No converter was created and no document was opened.

**The pnpm command still exited 1:** `ERR_PNPM_IGNORED_BUILDS` for `koffi@3.1.1`. This package has an install script; the repository has not decided whether to allow or deny it. pnpm's generated undecided placeholder in `sidecar/pnpm-workspace.yaml` was removed, leaving that policy file unchanged. Packages are present and load, but a clean install exit is not claimed.

The precise pending proposal sent to the parent thread is an exact-version restrictive decision, `allowBuilds: { "koffi@3.1.1": false }`, followed by a normal frozen-lockfile install. The prebuilt module demonstrably loads on this Mac without that script. Because the installation request explicitly reserved policy changes for confirmation, that decision has not been applied. This is not a minimum-release-age exception. Allowing the script is unnecessary for the checks already passed and was not performed. Strict confinement for actual Office conversion remains separately unresolved.

### Plugin-only correction

The user subsequently clarified that the dependency must be dynamic and plugin-owned, never default bundled. `pnpm --dir sidecar remove --workspace-root @deepseek-ai/libreoffice-kit` removed 18 installed packages and returned exit 0. Both entry and engine now report `MODULE_NOT_FOUND` through the sidecar dependency path. No supply-chain policy was changed. Shared pnpm download caches were left intact; a cache entry is not an application dependency.

Future integration must keep the engine package, platform assets and pinned dependency lock in the optional plugin's host runtime, provisioned only when its file-engine capability is requested. App startup, plugin discovery and ordinary lightweight Office editing must not download or load it. The Node module must be loaded by the supported host runtime after capability and ownership checks, not by the frontend plugin's browser bundle. Merely changing a sidecar import to `import()` would still bundle the declared dependency and does not meet this requirement.

Existing plugin activation/ownership, native invocation and CLI requirement checks remain reuse points. The repository's package preparation flow in `lib/plugin/pi-packages/operations.ts` is specific to contributed Pi packages; it is not an already-connected generic Office dependency installer. No unrelated Pi package wrapper or unconnected Office loader was added to simulate completion. The plugin-scoped engine provisioning/execution path remains outstanding along with the previously recorded confinement blocker.
