---
title: ADR-0068 — frontend package extraction, compile-speed & structure program
description: "The main app is ~873k LOC of non-test TypeScript in one flat compilation unit (single tsconfig program, single Next.js graph). This ADR records the research verdict — the frontend is already heavily optimized (pixi single-file alias, runtime-AMD Monaco, all heavy libs dynamically imported, self-tuning Jest), so the remaining wins are structural: a redundant in-build tsc, an uncached CI typecheck, a near-total absence of package boundaries in `lib/`, and a handful of god-files that are organizational (not logical) debt. It proposes a ranked set of zero-refactor compile-speed wins (drop the redundant build-time tsc, cache tsbuildinfo, defer heavy layout initializers), a leaf-first `@cognia/*` extraction ladder mirroring the established source-package pattern (starting with `@cognia/redact`, ending with the 750-consumer `@cognia/agent-config-types` compile boundary), and a domain-symmetric decomposition of the workflow forms/executor god-files using patterns already present in the tree."
---

# ADR-0068 — frontend package extraction, compile-speed & structure program

**Status**: Proposed (2026-07-13)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the existing `packages/*` source-package pattern (14 zero-build `@cognia/*` packages consumed as raw TS via `tsconfig.json` `paths` + `jest.config.ts` `moduleNameMapper`), the `next/dynamic(ssr:false)` initializer pattern already used for `DesktopOnlyInitializers` / `MobileOnlyInitializers`, the Zustand slice pattern already used by `stores/agent/agent-team-store/slices/`, and the domain-file split already begun under `components/workflow/editor/inspector/forms/` (`eval-forms.tsx`, `github-forms.tsx`, …). This is the frontend analog of **ADR-0067** (`src-tauri` crate decomposition & build-speed); the same "isolate a heavy graph behind a boundary so an edit stops recompiling everything" thesis applies to the TS program.

## Context

The main app's TypeScript (everything the browser / Tauri / Capacitor shells share) is one flat compilation unit. This is the dominant structural drag on frontend developer velocity and CI cost, and the numbers are unambiguous:

| Metric | Value | Consequence |
| --- | --- | --- |
| Non-test source (`app+components+lib+hooks+stores+types`) | **873,255 LOC** | One `tsconfig` program, one Next.js module graph |
| Test files (co-located) | **4,283** | All globbed into the same root `tsconfig` `include: **/*.ts(x)` |
| TS project references / `composite` | **0** | The whole ~9k-file program type-checks as one monolith |
| Static routes (`page.tsx`) | **92** (0 dynamic `[param]`, 0 `generateStaticParams`) | Clean static fan-out — good for `output:"export"` |
| `dynamic()` + `React.lazy` boundaries in `app`/`components` | **16 + 8** | Very few, but heavy libs are already among them (below) |
| `optimizePackageImports` | `["radix-ui","motion","recharts"]` | Near-optimal; the remaining barrels don't qualify (below) |
| `next build` type-check | full `tsc` over ~9k files, **not** `ignoreBuildErrors` | Runs even though CI has a separate `typecheck` job |
| Internal packages | **14** under `packages/*` (13 zero-build source packages, 1 tsup) | The extraction template is proven and cheap |

Two facts frame the whole program:

- **The frontend is already well-optimized.** pixi.js is aliased to its pre-bundled single file (`next.config.ts:72-73,181,196`), Monaco loads via a runtime AMD loader so it never enters the bundle (`lib/canvas/monaco-loader.ts`), and `three`/`mermaid`/`pdfjs-dist`/`@huggingface/transformers`/`xterm`/`docx`/`jspdf`/`xlsx`/`mammoth` are all `import()`-split. Jest already splits `node`/`jsdom` projects and self-tunes coverage workers by free RAM. There is **no low-effort "flip a flag" win of consequence left** except the redundant build-time tsc — the rest of the program is structural.
- **The team already reaches for `packages/*` when isolation matters.** `provider-types`, `provider-core`, `rag`, `document`, `vector`, `primitives`, `time`, … were each lifted out of `lib/*` precisely because they are leaf-like, framework-agnostic, and shared across shells. The pattern is understood and welcome; it simply hasn't been pushed to the next tier of candidates.

### Why the monolith is safe (and cheap) to peel apart

Three structural facts (measured, not assumed) make extraction unusually low-risk:

**1. The extraction template is a 3-file, zero-build move.** 13 of 14 packages have **no build step**: `package.json` points `main`/`types` at `./src/index.ts` and the `exports` map lists a `"cognia-source"` condition + `"default"`, both at raw `.ts`. Resolution is wired in exactly three places — `tsconfig.json` `paths` (`:25-53`), `jest.config.ts` `moduleNameMapper` (`:130-144`), and `pnpm-workspace.yaml`. Adding a package therefore costs: create `packages/xyz/{package.json,tsconfig.json,src/}` → add one `paths` alias → add one `moduleNameMapper` line → rewrite import sites. `next.config.ts` never mentions `@cognia` (Next resolves the aliases natively from `tsconfig`), so there is nothing to touch there. Only `provider-types` (the leaf-most) additionally `tsup`-builds a `dist/`, and only to prove it compiles standalone.

**2. Cross-shell coupling already exists — as deep `@/` reach-ins that _want_ to be boundaries.** The standalone CLI (`cli/src`, which lives in the main TS program so it can reuse app logic) imports app internals via the `@/…` alias: **`@/lib/claude` 188×**, `@/lib/db` 32×, `@/lib/ai` 28×, `@/lib/plugin` 24×, `@/lib/workflow` 13×. These are not accidents — they are stable dependencies that today have no package boundary, so every app-side edit to `lib/claude/*` invalidates the CLI's type graph too.

**3. The largest "god-files" are organizational, not logical, debt.** The two biggest offenders share a toolkit / registry and are pure size problems with a split pattern _already present in the same directory_:

| File | LOC | Nature | Existing pattern to copy |
| --- | --- | --- | --- |
| `components/workflow/editor/inspector/forms/index.tsx` | 7,816 (113 `*Config` components) | **Organizational** — all consume the shared `./shared/` toolkit (`Field`, `readString`, `patchParam`, `ExpressionField`, `CronBuilder`); no copy-paste | Sibling `eval-forms.tsx`, `github-forms.tsx`, `git-ocr-forms.tsx` are already domain-split |
| `lib/workflow/nodes/built-ins.ts` | 4,773 (117 handlers) | **Mixed** — 43 imports across ~40 unrelated `lib/` domains | Mirror the forms domain split + a thin registry |
| `lib/claude/build-options.ts` → `resolveSendOptions` | 2,350-line single function (`:897-3247`) | **Mixed** — convergence orchestrator | File already has phase-resolver seams (`resolveMemberConfig`, `teamHasKnowledgeTwins`) |
| `hooks/chat/use-claude-chat.ts` | 2,816 | Orchestrator | Neighbors already extracted (`steer-runtime`, `stream-coalescing`, `use-artifact-detection`) |
| `stores/artifact/artifact-store.ts` / `stores/settings/settings-store.ts` | 1,933 (102 actions) / 1,540 | No slicing | `stores/agent/agent-team-store/slices/` is the in-repo slice precedent |

The measured `lib/` subsystem sizes also expose the shape of the extraction frontier — a few clean leaves surrounded by a large Dexie/twin-coupled core that must **not** move:

| Extractable (leaf-like) | Coupled core (stays in app) |
| --- | --- |
| `packages/redact/src/index.ts` (0 `@/` imports), `lib/search` (24, 3 injectable leaks), `lib/logging` (26 + `types/logging` leaf), `lib/claude/types.ts` (type-only hub), `lib/tts` (25, 4-file native bridge) | `lib/db` (119, _is_ the Dexie schema), `lib/workflow` (150), `lib/plugin` (265), `lib/connectors` (184), `lib/scheduler` (43), `lib/goal`/`lib/radar`/`lib/memory`/`lib/a2ui`/`lib/slash-commands`/`lib/ocr` (Dexie/twin glue) |

## Decision

Adopt a **three-track frontend program** — (T1) zero-refactor compile-speed wins, (T2) a leaf-first `@cognia/*` extraction ladder, (T3) domain-symmetric decomposition of the god-files — executed in a phased, concurrency-safe order that lands the flag-flip wins first and extracts one leaf package as the reusable template. No runtime behavior changes; the emitted `out/` must stay byte-compatible for the Tauri and Capacitor shells.

### Track 1 — Compile-speed measures (ranked by ROI)

| # | Lever | Change | Impact | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| **C1** | Drop the redundant in-build tsc | `typescript.ignoreBuildErrors: true` in `next.config.ts` (`:129-131`). `next build` currently full-checks ~9k files, but `quality.yml` already runs `pnpm typecheck` as a separate job and CI never caches `*.tsbuildinfo` (gitignored) → the in-build check is a **cold full tsc every build**. SWC still compiles; `out/` is byte-identical. | **-30–50% CI `build` job**; large local `pnpm build` win | **S** | M — type gate must stay enforced elsewhere (it is: quality job + local `pnpm typecheck`) |
| **C2** | Cache `*.tsbuildinfo` in CI | Add `actions/cache` for `tsconfig.tsbuildinfo` in `quality.yml`, keyed on lockfile + source hash with a lockfile-only `restore-keys` fallback (same shape as `test.yml:246-253`). `incremental:true` already works locally; CI just never restores it. | **-40–70% CI typecheck** on small PRs | S | Low — buildinfo is advisory; stale/missing → full check |
| **C3** | Defer heavy layout initializers | Collect the web-side `null`-rendering initializers (`WorkflowRuntimeProvider`, `GatewayProvider` + `RoutingRuntimeInitializer`, `ConnectorBusProvider`, `SchedulerInitializer`, `AgentTeamRuntimeInitializer`) into one `next/dynamic(ssr:false)` bundle, copying the proven `desktop-only-initializers.tsx` pattern. Removes the `lib/workflow` / gateway-routing / connector subsystem graphs from every route's synchronous first-paint compile. | **-15–30% dev cold-start**, lower `pnpm dev` RAM | M | M — preserve child mount order (`app/layout.tsx:216-221` has ordering comments); components render `null` so `ssr:false` is export-safe |
| **C4** | mtime-skip prebuild sidecar tsc | `scripts/build/build-webclone-sidecar.mjs:70-71` and `build-vscode-ext-host-sidecar.mjs` run `npm run build` (tsc) **unconditionally** every `prebuild`. Add a `newest(src) > dist` skip like `copy-monaco-assets.mjs`. | -10–30s per `pnpm build` / `tauri build` when sidecar src unchanged | S | Low — dists never enter the renderer bundle |

**Explicitly evaluated and _not_ adopted** (evidence-backed, to prevent re-litigation):

- **Adding `@xyflow/react` to `optimizePackageImports`** — no-op. Its `exports` map exposes only a single `.` barrel (no subpaths), so Next cannot rewrite imports into it. The `optimizePackageImports` list is already near-optimal (`radix-ui` is used via the meta-barrel in 34 files vs 4 subpath users; `lucide-react`/`date-fns` are in Next's built-in default list).
- **A bespoke `splitChunks`** — App Router default chunking already per-route-splits the dynamic heavy libs. A custom config risks the tuned `out/` that Tauri/Capacitor consume. The one real duplication (**shiki** leaking into the chat shared chunk + a second copy inside `@streamdown/code`) is a bundle-size concern, not a compile-speed one; address it only on a measured bundle regression.
- **Re-enabling `turbopackFileSystemCacheForDev`** — blocked upstream by a single-writer corruption race (vercel/next.js#90691); Next exposes only on/off, no safe partial enable. Keep it off (`next.config.ts:155`); revisit on the upstream fix.
- **TS project references for `packages/*` (broadly)** — the monolithic `app`/`components`/`lib` program dominates the ~9k files, so references buy only a small slice at real cost (composite requires `declaration` emit + `moduleResolution` constraints + 15 reference wirings). The _one_ place it pays is the `lib/claude/types.ts` boundary (Track 2, E5).

### Track 2 — `@cognia/*` extraction ladder (leaf-first)

Each rung uses the zero-build source-package template. The rung order is **coupling-first**: prove the flow on a trivial leaf, establish the `{ fetch, getSecret, model }` dependency-injection convention on the mid-size runtime packages, then do the wide codemod boundaries last.

| # | Package | Moves in | Coupling to break | Effort | Payoff |
| --- | --- | --- | --- | --- | --- |
| **E1** | `@cognia/redact` | `packages/redact/src/index.ts` (pure-regex PII scrubber) | **None** — 0 `@/` imports. Sibling `redaction-key.ts` (keyring) has 2 consumers, stays app-side or injects a `KeyProvider` | **S** | Security-critical gate shared by 81 sites (Twin, Goal, connector auto-mode, Agent-Team, plan gate); independently auditable; sidecar can adopt the real scrubber |
| **E2** | `@cognia/web-search` | all of `lib/search` (24 files, 11 provider adapters) | 3 injectable leaks: `useSettingsStore` → `SearchConfig` param; `standalone-answer.ts:19-25` model/fetch → `{ model, fetch }` handle | M | Framework-agnostic; today app-only. CLI has no web search; a package makes it reusable across shells and hides 11 third-party adapters behind peer deps |
| **E3** | `@cognia/tts` | `lib/tts` (25 files) + `types/media` leaf | Native bridge confined to 4 files (`keyring`, `proxy-fetch`, `providers/edge`, `providers/openai-realtime`) → inject `{ fetch, getSecret }` | M | Wanted on mobile (Capacitor) + sidecar; isolates 3rd-party TTS providers |
| **E4** | `@cognia/logging` | `lib/logging` core + `types/logging` (near-pure leaf) | Platform transports isolated to 5 bootstrap/transport files → keep as app-registered plugins (already pluggable) | M | **344 import sites** (2nd-widest hub). CLI carries its own 11-file logger → real convergence target; compile-isolating the hub cuts incremental rebuild fan-out |
| **E5** | `@cognia/agent-config-types` | `lib/claude/types.ts` (`AppSettings` / `SendOptions` hub) — **not** `build-options.ts` (that's runtime glue, stays app-side) | Type-only; pulls 4 type siblings (`lib/search/types` — falls out of E2; `types/pet`; `types/lsp/config`; `types/system/compression`) → co-move or re-export as peer leaves | **L** (codemod) | **750 import sites — the single largest compile boundary in the repo.** Editing app runtime code stops invalidating 750 type-consumers; the CLI's 188 `@/lib/claude` reach-ins become a stable package edge. This is the one case where a TS project-reference edge is worth it |

**General rule (from the `provider-types` precedent):** any Dexie/twin-coupled subsystem that fails the leaf test (`goal`, `radar`, `memory`, `scheduler`, `a2ui`, `slash-commands`, `ocr`) is **not** extractable as a whole — its only clean first move is lifting its already-pure `types/*` sibling (verified: `types/goal`, `types/radar`, `types/memory` have 0–1 back-references into `lib`).

### Track 3 — God-file decomposition (domain-symmetric)

| # | Target | Split |
| --- | --- | --- |
| **S1** | `forms/index.tsx` (7,816) + its 71 KB `index.test.tsx` | Extract by domain (`goal-forms`, `scheduler-forms`, `team-forms`, `plan-forms`, `terminal-forms`, `connector-forms`, `ai-forms`, `mobile-forms`); convert `index.tsx` to a re-export barrel so all 5 consumers stay stable. Split tests in lockstep. **L, mechanical.** |
| **S2** | `lib/workflow/nodes/built-ins.ts` (4,773) | Mirror S1's domain boundaries (`goal-nodes`, `scheduler-nodes`, …) + a thin registry. Pairs naturally with S1. **L.** |
| **S3** | `build-options.ts::resolveSendOptions` (2,350-line fn) | Extract pure phase resolvers (`resolveA2uiCapabilities`, `resolveComputerUseTools`, `resolveTwinRuntime`, `resolveGoalContext`, `resolveBriefMode`); keep a ~200-line orchestrator. Behind the existing test suite. **M–L.** |
| **S4** | `use-claude-chat.ts` (2,816) | Continue the neighbor pattern: `use-chat-send`, `use-chat-events`, `use-chat-session-lifecycle`. **L.** |
| **S5** | `artifact-store.ts` (102 actions) + `settings-store.ts` | Adopt the existing `agent-team-store/slices/` pattern. **M.** |
| **S6** | `characters-section.tsx` (2,351, 8 components) | Split to `character-editor`, `character-row`, `character-packs`, `computer-use-sub-settings`. **M.** |
| **S7** | Directory hygiene | Merge `lib/file`↔`lib/files`, `lib/theme`↔`lib/themes`; move `lib/data-hooks/` → `hooks/data/`; document the `stores/plugins`↔`stores/plugin-runtime` boundary. **S each.** |
| **S8** | Test backfill | 15 missing tests in `chat/message-parts/mcp-renderers/*` (8) + `chat/renderers/*` (7) — they render untrusted model output (highest latent-bug surface). **M.** |

**Leave alone (large but cohesive):** `lib/claude/types.ts` (pure types — but it _becomes_ E5, moved not split), `lib/plugin/core/manager.ts` (single well-tested lifecycle class).

## Migration plan

Each step is an independent commit, gated by `pnpm test:changed` (or scoped `npx jest <paths>` — see `gotcha_rtk_test_masks_jest_exit_2026-07-13`), `pnpm typecheck`, and `pnpm lint:i18n`. Order minimizes conflict surface against concurrent WIP (config-only first, wide codemods last).

1. **C1 + C2 + C4 batch** — touches only `next.config.ts` + `.github/workflows/*` + two `scripts/build/*.mjs`. Almost no app code; lowest conflict surface. Immediate CI/build speedup.
2. **Extract `@cognia/redact` (E1)** — the **template PR**: proves the create-package → alias → mapper → rewrite-imports flow end-to-end on a zero-coupling leaf, and hardens a security-critical gate.
3. **S1 + S2 god-file split** — `forms/index.tsx` + `built-ins.ts` by symmetric domain boundaries (do together; the boundaries are identical). Mechanical, high structural payoff, no runtime change.
4. **S5 store slicing** — adopt the existing slice pattern for `artifact-store` / `settings-store`.
5. **C3 initializer deferral** — dev-speed win; needs care on mount order, so after the mechanical work settles.
6. **E2 `@cognia/web-search` + E3 `@cognia/tts`** — independent M extractions establishing the `{ fetch, getSecret, model }` DI convention.
7. **S3 + S4** — `resolveSendOptions` phase-resolvers and `use-claude-chat` sub-hooks, behind their test suites.
8. **E4 `@cognia/logging` (344 sites) → E5 `@cognia/agent-config-types` (750 sites)** — the wide codemod boundaries, last, once DI conventions and the extraction template are battle-tested. E5 additionally introduces the one worthwhile TS project-reference edge.
9. **S7 + S8** — directory hygiene and test backfill, opportunistically alongside the above.

## Consequences

- **Dev/CI inner-loop:** dropping the redundant build-time tsc (C1) and caching the CI typecheck (C2) directly cut the two most-run gates; deferring layout initializers (C3) shrinks every route's first-paint compile graph.
- **Compile isolation:** each `@cognia/*` boundary stops app-side edits from invalidating that package's consumers. E5 alone insulates 750 type-consumers (and the CLI's 188 reach-ins) from app runtime churn.
- **Cross-shell reuse:** `redact`, `web-search`, `tts`, `logging` become consumable by the CLI, sidecar, and mobile shells instead of being app-only or re-implemented per shell.
- **Structural clarity:** the forms/executor god-files gain the domain layering they already half-have; the stores adopt the slicing the codebase already models; the two workflow files split along the _same_ boundaries, keeping form ↔ executor parity obvious.
- **No output change:** every measure preserves `output:"export"` — C1/C4 change only _whether/when_ non-visual work runs, C3's components render `null` on the server, and the `@cognia/*` packages are source-resolved (identical emitted graph).

## Risks

- **Concurrent-tree hazard.** The working tree carries a large volume of uncommitted work from other sessions, and Track 2/3 rewrite shared/high-fan-in files (`tsconfig.json`, `jest.config.ts`, `forms/index.tsx`, `lib/claude/types.ts`). Sequence config-only steps first and do one package / one god-file per commit; use the hunk-filter split technique when a file carries mixed WIP. See `concurrent-tree-safety` and `gotcha_split_concurrent_features_hunk_filter_2026-07-12`.
- **The E5 codemod blast radius (750 sites).** Do it as a scripted find-replace with a full `pnpm typecheck` gate, after E2 removes the `lib/search/types` sibling coupling. Land E1–E4 first so the template and DI conventions are proven.
- **Coverage gate.** Any file moved into `packages/*` must be added to `collectCoverageFrom` + a threshold group in `scripts/test/coverage-thresholds.json` (the existing packages already carry their lib-era floors), or the ≥90% gate silently loses enforcement.
- **i18n parity.** God-file splits (S1, S6) move user-facing strings; run `pnpm lint:i18n` and keep `en.json`/`zh-CN.json` in parity per the working rules.
- **Jest ESM shims.** New packages that pull ESM-only deps must extend the `transformIgnorePatterns` allow-list / `moduleNameMapper` (`jest.config.ts:247-250`), the same way `@cognia/document` handles its peers.

## Non-goals

- No runtime behavior change, no dependency upgrades, no change to `output:"export"`, the route set, or the bundle layout consumed by Tauri/Capacitor.
- Not extracting the Dexie/twin-coupled core (`lib/db`, `lib/workflow`, `lib/plugin`, `lib/connectors`, `lib/scheduler`, `lib/goal`, …) — those are integration glue by design; only their pure `types/*` leaves are eligible, tracked opportunistically.
- Not decomposing `build-options.ts` into a package (it stays app-side runtime glue); only `lib/claude/types.ts` is the E5 leaf.
- No broad TS `composite`/project-reference migration beyond the single E5 boundary.

## Alternatives considered

- **Only the Track-1 flag flips.** Real but bounded; leaves the 873k-LOC single-program invalidation and the god-files intact. Track 1 is adopted _as well_, not _instead_.
- **`transpilePackages` / a Next-level package boundary instead of source packages.** Heavier and redundant — the repo already resolves `@cognia/*` natively via `tsconfig` `paths`; source packages give the compile boundary with zero build step.
- **Splitting god-files by internal `//region` markers or nested `#[path]`-style barrels only.** Does not change the module boundary the compiler sees; no incremental-isolation benefit. Real files (Track 3) are required.
- **A broad `composite` project-reference migration.** Rejected outside E5: the app/components/lib bulk stays in one program that can't be cheaply split, so the cost/benefit is poor (see Track 1 non-adopted list).

## Appendix — measured data (2026-07-13)

- LOC / file counts, route counts, lazy-boundary counts, `optimizePackageImports` fitness, per-`lib/`-subsystem sizes, and cross-shell coupling counts were captured via `find`/`wc`/`grep` over `app/ components/ lib/ hooks/ stores/ types/` and `cli/src/`, plus reads of `next.config.ts`, `tsconfig.json` + `tsconfig.build.json`, `package.json`, `jest.config.ts`, `app/layout.tsx`, and the `scripts/build/*.mjs` chain.
- Reproduce the headline numbers:
  - source LOC: `find app components lib hooks stores types -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' ! -name '*.stories.*' -print0 | xargs -0 cat | wc -l`
  - lazy boundaries: `grep -rl "dynamic(" app components | wc -l` / `grep -rl "lazy(" app components | wc -l`
  - project references: `grep -rc '"references"' tsconfig*.json` → 0
  - CLI coupling: `grep -rho "@/lib/[a-z-]*" cli/src | sort | uniq -c | sort -rn`
  - package build mode: `for p in packages/*/; do [ -f "$p/tsup.config.ts" ] && echo "$p tsup"; done` → only `provider-types`

## Key files

- Compile-speed targets: `next.config.ts:129-131` (C1), `.github/workflows/quality.yml` (C2), `app/layout.tsx:210-249` + `components/providers/initializers/desktop-only-initializers.tsx` (C3 pattern), `scripts/build/build-webclone-sidecar.mjs:70-71` + `build-vscode-ext-host-sidecar.mjs` (C4)
- Extraction template: `packages/primitives/{package.json,tsconfig.json}` (zero-build), `packages/provider-types/tsup.config.ts` (the sole build step); wiring in `tsconfig.json:25-53`, `jest.config.ts:130-144`, `jest.config.ts:259-289` (coverage globs)
- Extraction candidates: `packages/redact/src/index.ts` (E1), `lib/search/standalone-answer.ts:19-25` (E2 injection points), `lib/tts/` (E3), `lib/logging/` + `types/logging` (E4), `lib/claude/types.ts` (E5), `cli/src` (the 188× `@/lib/claude` consumer that E5 stabilizes)
- God-files: `components/workflow/editor/inspector/forms/index.tsx` (S1), `lib/workflow/nodes/built-ins.ts` (S2), `lib/claude/build-options.ts:897-3247` (S3), `hooks/chat/use-claude-chat.ts` (S4), `stores/artifact/artifact-store.ts` + `stores/agent/agent-team-store/slices/` (S5 target + precedent)
