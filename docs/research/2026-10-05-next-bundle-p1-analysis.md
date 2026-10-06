# P1 bundle optimization analysis — 2026-10-05

Analyze the two proposed P1 areas separately: dependency consolidation and eager plugin-validation/icon imports. **Implement dependency consolidation first.** It has clearer acceptance criteria. The import work needs several coordinated boundaries; moving one import will not necessarily remove a large module from the initial bundle.

This follow-up rechecks the current shared working tree after P0. No application, package manifest, lockfile, or generated catalog was changed. No installation, dedupe, or production build was run. Size figures refer to the [completed baseline](../reports/next-bundle-analysis-2026-10-05.md), not newly measured savings. The previous build's missing `codex-app-server-client` source file is still absent; restore a buildable snapshot before comparing production output.

## P1-A: dependency consolidation

### Supported Streamdown upgrade

Current installed identities still differ: the root uses Shiki **4.4.3**, while `@streamdown/code@1.1.1` resolves Shiki **3.23.0**. The published `@streamdown/code@2.0.0` manifest and tarball were rechecked: it requires `shiki ^4.4.3`, supports the project's React/Node versions, and retains `createCodePlugin({ themes })`. Installed `streamdown@2.6.0` accepts a structural code-plugin interface and does not itself require a Shiki runtime version.

Smallest experiment:

1. Pin root `@streamdown/code` to `2.0.0` for the experiment.
2. Update only the relevant dependency resolution; verify the plugin and app resolve the **same actual Shiki path**, not just compatible ranges.
3. Compare main-app analyzer occurrences before/after. The separate docs workspace may legitimately retain its own Shiki version.

The upgrade changes incremental tokenization and caching. Existing `createCodePlugin` calls should remain compatible, but type compatibility is not behavioral proof. Do not combine this with P2's custom highlighter adapter or regex-engine migration.

**Expected direction:** fewer duplicated Shiki modules and emitted async assets. **Unmeasured:** exact export/initial JS reduction. The historical **39.35 MiB** Shiki attribution includes required grammars, themes, and repeated occurrences; it is not the expected saving.

**Important test gap:** `jest.config.ts:361` maps `@streamdown/code` to a mock. The HTML highlighter and streaming tests also mock Shiki or Streamdown. Keep these contract tests, but add an unmocked package check and production browser validation for streaming-to-final output, both themes, aliases, embedded/uncommon languages, unknown-language fallback, and long/multiple snippets.

### Zod peer alignment

The root still resolves Zod **4.6.5**. Five private workspaces—`eval-core`, `provider-core`, `provider-types`, `rag`, and `router-fusion`—have wildcard Zod peers resolving **4.4.3**. Installed realpaths confirm that root and `provider-core`/`rag` load the same `ai@7.0.116` and `@ai-sdk/openai@4.0.78` versions under different Zod peer contexts. Both SDKs accept Zod 4.6.5.

Use the existing catalog convention:

- Add `catalog.zod: "4.6.5"` to `pnpm-workspace.yaml`.
- Set the root Zod dependency to `catalog:`.
- Give the five private workspaces a `devDependencies.zod: "catalog:"` while preserving their existing peer contract.
- Resolve the affected importers and inspect both lock entries and installed realpaths. Keep legitimate Zod 3 dependencies.

This is more durable than a lock-only update while avoiding a global override. Setting catalog peers directly is another option, but would tighten their peer contract to an exact version; that is unnecessary for the first experiment. `dedupePeerDependents` cannot reconcile genuinely different peer versions by itself.

**Verify:** schema/tool conversion with the real dependencies, provider/RAG/eval/router schema tests, package typechecks, and SDK packaging. Existing RAG tests mock `ai`, so unit tests alone are insufficient. Confirm duplicated SDK peer contexts disappear from the main-app build before claiming a size win.

## P1-B: eager validation and icon metadata

### Correction to the earlier single-import proposal

`stores/plugin-runtime/plugin-store.ts:30` statically imports `validatePluginManifest`, used only in the already-async `scanPlugins` at line 983. Deferring that import is a sensible seam, but it does **not** cut all paths from the global runtime to validation/schema.

A TypeScript AST probe simulated removing import edges without editing source. It excludes type-only imports, but does not evaluate Webpack symbol-level tree shaking or external package graphs. Its result is a boundary candidate, not proof of emitted bytes:

| Simulated change                                                                    | Validation/schema still reachable?                    | Full icon catalog still reachable? |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| Defer store validation                                                              | Yes, through updater/marketplace and IDE proxy paths  | Yes, through desktop shell         |
| Also isolate the update-event contract                                              | Yes, through workflow publication and cogpack helpers | Yes                                |
| Also split icon validation metadata                                                 | Yes                                                   | Yes                                |
| Also defer workflow publication preflight and isolate cogpack ID/version predicates | No in the inspected static graph                      | Yes                                |

The actual paths explain the required work:

- `AppRuntime → ContextKeysInitializer → plugin-store → validation → IDE manifest/schema`.
- `AppRuntime → PluginUpdateToaster → updater → marketplace/IDE proxy`. The toast imports only an event name and a type from the large updater module (`components/plugins/plugin-update-toaster.tsx:21`).
- `AppRuntime → StorageRetentionInitializer → retention → workflow retention/batch service → workflow DB → publication preflight → validation`.
- `cogpack/manifest.ts:12` imports the small synchronous `isValidPluginId` and `isValidPluginVersion` predicates from the full validation module.

### Smallest coherent boundary experiment

1. Load validation inside async `scanPlugins`, before filtering results. Preserve invalid-manifest rejection, governance mode, and failure behavior; never insert unvalidated results. Add direct scan tests: current plugin-store tests do not directly exercise this operation.
2. Give updater notifications a lightweight event-name/type contract used by both emitter and toast. Keep the event name, payload and deduplication semantics. The existing plugin-intent event module owns a different event; do not force this change into that unrelated contract or duplicate string literals.
3. Load `assertWorkflowPluginPublicationPreflight` inside `publishWorkflowApp` immediately before its existing awaited call (`lib/db/workflow-apps.ts:407`). Keep it before the publication transaction and preserve signature, dependency, identity and governance checks. Do not turn the synchronous manifest validator into an asynchronous API across the repository.
4. Isolate the existing plugin ID/version predicates into a dependency-light owner, with re-exports if required by public imports. Preserve reserved names, length, case and prerelease behavior. Reusing another module's superficially similar regex would be unsafe without equivalence tests.

This is a four-boundary experiment, not four promised size reductions. Rebuild after the coherent change and inspect module reasons/layers. Barrel exports, module side effects and runtime startup imports may change the result. Production boot still forces the `eager` profile (`lib/boot/capabilities.ts:37`), so moving bytes out of HTML references may only shift their load until shortly after hydration. Measure initial scripts and post-hydration requests separately.

### Icon metadata: useful separation, uncertain first-load benefit

`lib/plugin/core/validation.ts:27` needs icon-name checks but imports the catalog that also contains all SVG nodes. Reuse `scripts/build/generate-lucide-catalog.mjs` to generate a dependency-light metadata artifact and preserve all aliases. The current catalog has **1,854 icon names and 6,342 export names**.

Current serialization measurements:

| Representation                 |       Raw |      Gzip |
| ------------------------------ | --------: | --------: |
| Full catalog                   | 839,806 B | 174,848 B |
| Names and export-alias mapping | 217,623 B |  42,039 B |
| Difference                     | 622,183 B | 132,809 B |

These are representation sizes, not compiled savings. The shell independently imports the renderer through `guild-rail.tsx:46 → plugin-view-container-panel.tsx:14 → lucide-catalog.tsx`. Chat/A2UI consumers also use it. Therefore metadata separation alone cannot be credited with removing the full catalog from first load. Avoid retaining the same metadata in both generated outputs if splitting them.

Preserve exact/PascalCase/kebab-case resolution, aliases, SVG geometry/classes, accessibility attributes, and stable cached component identities. Reuse generator parity tests, `lib/icons/lucide-catalog.test.tsx`, `lucide-icon-name.test.ts`, manifest validation tests, updater-toast tests and workflow publication tests. Loading icon rendering on demand is a separate UI/lifecycle change and should only be added if the next analyzer result justifies it.

## Decision and acceptance

Recommended order: **Streamdown upgrade → Zod alignment → coherent validation-boundary experiment → reassess icon metadata benefit**. Keep each dependency change independently measurable. P1-A has moderate compatibility risk with clear resolution checks; P1-B has a larger behavioral surface and less certain initial-payload benefit.

Use one stable source snapshot for before/after production Webpack builds. Compare all client JS, homepage and lightweight-route HTML script references, and PWA precache bytes separately. Verify real highlighting/schema behavior, plugin discovery/update notifications, and workflow publication. Current broad PWA precaching means lazy modules may still download during installation. Do not advertise `1.63 + 0.80 MiB` as a guaranteed first-load saving, or the 39.35 MiB Shiki attribution as removable.

Evidence: `.cache/bundle-analysis/2026-10-05/p1-dependency-review.md` records current manifest/realpath and published-package checks; `p1-import-cut-probe.cjs` and `.json` record the static boundary simulation. Analysis did not run implementation tests or produce an optimized build.

## Sources

- [Published Streamdown code 2.0.0 manifest](https://registry.npmjs.org/@streamdown/code/2.0.0) and [tarball](https://registry.npmjs.org/@streamdown/code/-/code-2.0.0.tgz): released dependency and API evidence, read without installation.
- [Streamdown code plugin](https://streamdown.ai/docs/plugins/code): supported integration surface.
- [pnpm catalogs](https://pnpm.io/catalogs) and [peer dependency settings](https://pnpm.io/settings/peer-dependencies): explicit workspace resolution and peer behavior.
- [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading): dynamic import boundaries.
- [Webpack tree shaking](https://webpack.js.org/guides/tree-shaking/): why syntactic reachability alone cannot predict retained production code.
