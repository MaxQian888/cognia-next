# Cognia A2UI and OpenUI: replacement assessment

Date: 2026-10-20 (Asia/Shanghai)

Status: research and offline contract checks; no product integration or migration performed.

Follow-up: the user selected strengthening the existing implementation as the preferred direction. See the [current A2UI strengthening audit](2026-10-20-a2ui-strengthening-audit.md) for official v0.9.1/v1.0 status, full local shadcn inventory, verified behavior gaps, and the revised work sequence. The pilot recommendation below records the earlier replacement assessment.

## Recommendation

Adopt OpenUI selectively if the goal is better model-generated UI streaming and a component-driven generation contract. Do not replace Cognia's complete A2UI subsystem based on the shadcn example alone.

The useful replacement candidate is the **model-output language, parser, and generation renderer**. Cognia's surface lifecycle, durable apps, visual editor, plugin API, MCP projection, workflow interactions, and IM adapters have a much larger responsibility than that renderer. These services need explicit adapters or migration even if OpenUI becomes the preferred generator.

For appearance alone, extend the existing component library and improve generated composition. Cognia already renders its A2UI buttons and many other controls through its own shadcn primitives. Changing the language does not itself improve typography, spacing, information architecture, or component selection. See [button implementation](../../components/a2ui/form/a2ui-button.tsx) and [renderer registry](../../components/a2ui/a2ui-renderer.tsx).

This recommendation is an architectural assessment, not a measured performance win. No paid model benchmark, browser acceptance, Tauri acceptance, or production verification was run.

## Evidence scope

- Cognia: current checked-out source at HEAD `07eb0d44b5567f815bbdf70bcb7693f518a9a38d`, inspected on 2026-10-20. The worktree has substantial concurrent changes, including an existing modification to `sidecar/src/tools/a2ui/tool-defs.ts`. Findings describe the inspected source, not the deployed app.
- OpenUI: upstream commit [`9823ec05d4b29bc78d101676dc16b44fe17f1830`](https://github.com/thesysdev/openui/commit/9823ec05d4b29bc78d101676dc16b44fe17f1830), dated 2026-10-19. Registry checks found `@openuidev/react-lang` / `@openuidev/lang-core` 1.0.1 and `@openuidev/a2ui` 0.5.0. Package and source versions are distinct from the maturity of a complete Cognia integration.
- Navigation: CodeGraph CLI exists but this checkout has no index; source inspection used targeted `rg` and file reads. No index was created.
- Additional source audit and the upstream schema probe are documented in [OpenUI upstream analysis](2026-10-20-openui-upstream-analysis.md).

## What Cognia currently owns

| Layer                        | Current implementation and observed behavior                                                                                                                                                                                                                                                                | Replacement consequence                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol and schema          | [schema](../../types/a2ui/schema.ts), [parser](../../lib/a2ui/parser.ts): custom `type`-discriminated messages, simplified `{surface, components, dataModel}` blocks, JSON Pointer data bindings, custom `surfaceReady`                                                                                     | Need a versioned format boundary; renaming packages cannot convert the protocol                                                                           |
| Native component rendering   | [catalog](../../lib/a2ui/catalog.ts), [renderer](../../components/a2ui/a2ui-renderer.tsx): 68 standard component names, all present in the built-in renderer map; extension lookup; lazy heavyweight components                                                                                             | Existing primitives and specialized components remain valuable; OpenUI definitions must map their props, children, and actions                            |
| Surface state and history    | [store](../../stores/a2ui/a2ui-store.ts): component maps by ID, data model, incremental upserts, root selection, subtree editing, undo/redo, streaming status                                                                                                                                               | OpenUI's renderer state is not a substitute for editor/history semantics                                                                                  |
| Durable apps and cache       | [app database](../../lib/db/a2ui-apps.ts), [surface database](../../lib/db/a2ui-surfaces.ts), [initializer](../../components/providers/initializers/a2ui-surface-persistence-initializer.tsx), store hydration/flush                                                                                        | Existing saved payloads must remain readable, or receive a tested migration                                                                               |
| Model generation and editing | [AI generation](../../lib/a2ui/ai-generate.ts), [generation prompts](../../lib/a2ui/generate-prompts.ts): existing headless agent transport, PII gate, streamed tool dispatch, captured surfaces, deterministic create fallback, edit failure preservation                                                  | Reuse model routing, cancellation, redaction, and fallback semantics; a new provider path would add unnecessary work                                      |
| Chat integration             | [message integration](../../components/a2ui/a2ui-message-renderer.tsx), [chat part](../../components/chat/message-parts/a2ui-part.tsx), [markdown block](../../components/chat/renderers/a2ui-block.tsx), [part contract](../../lib/claude/parts-extensions.ts)                                             | Add a distinct versioned OpenUI content path rather than silently parsing saved JSON as Lang                                                              |
| Mini-app editor              | [workspace](../../components/a2ui/workspace/a2ui-workspace.tsx), [component factories](../../lib/a2ui/component-definitions.ts), [properties](../../lib/a2ui/component-properties.ts), [import validation](../../lib/a2ui/app-import.ts)                                                                    | DSL expressions, queries, and mutation graphs do not automatically round-trip through an ID-based JSON visual editor                                      |
| Actions and built-in apps    | [event bus](../../lib/a2ui/events.ts), [global action provider](../../components/providers/a2ui-built-in-actions-provider.tsx), [action handlers](../../hooks/a2ui/app-builder/action-handlers.ts)                                                                                                          | Map action names, component identity, form values, state changes, and lifecycle cleanup; a generated button alone does not implement a business operation |
| External agents              | [five MCP tool schemas](../../lib/a2ui/mcp-tool-schemas.ts), [IPC](../../lib/a2ui/ipc.ts), [ACP sniffer](../../lib/a2ui/acp-bridge.ts), [headless runtime](../../lib/headless/runtimes/a2ui-dispatch.ts)                                                                                                    | Preserve existing agent contracts or introduce an explicit new capability/version                                                                         |
| Plugins                      | [plugin bridge](../../lib/plugin/bridge/a2ui-bridge.ts), [SDK component API](../../packages/plugin-sdk/src/api/a2ui-component.ts)                                                                                                                                                                           | Plugins expect Cognia component registration, store updates, lifecycle hooks, and events                                                                  |
| IM and workflows             | [surface-to-segment projection](../../lib/connectors/a2ui-bridge/a2ui-to-segments.ts), [shared adapter traversal](../../lib/connectors/adapters/_shared/a2ui-mapper.ts), [workflow approval](../../lib/a2ui/workflow-approval-handler.ts), [callback handler](../../lib/a2ui/connector-callback-handler.ts) | React rendering cannot replace semantic projection to native IM cards or callback routing                                                                 |

These paths are wired into runtime: [app runtime](../../components/runtime/app-runtime.tsx) mounts A2UI dispatch and built-in action providers; [headless runtime registration](../../lib/headless/runtimes/index.ts) imports the A2UI dispatcher; [send-options assembly](../../lib/claude/build-options.ts) gates tools and appends the A2UI prompt. This is source wiring evidence, not a live end-to-end acceptance claim.

No `@openuidev`, `thesysdev/openui`, or OpenUI Lang reference was found in the searched product source, package manifest, or lockfile at the start of this audit. Cognia currently has no direct implementation dependency on this OpenUI project.

## A2UI, Cognia A2UI, and OpenUI are three different contracts

Google/A2UI's official v0.9 messages use a versioned envelope, for example:

```json
{
  "version": "v0.9",
  "createSurface": {
    "surfaceId": "main",
    "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"
  }
}
```

Cognia's parser instead expects:

```json
{
  "type": "createSurface",
  "surfaceId": "main",
  "surfaceType": "inline",
  "catalogId": "cognia-standard-v1"
}
```

It also accepts the simplified object taught by [its system prompt](../../lib/a2ui/prompts.ts). Its data update discriminator is `dataModelUpdate`, whereas official v0.9 uses the `updateDataModel` envelope. Components share some concepts and names, but button/action structures, catalog semantics, and lifecycle also need mapping. The header comment saying “Based on A2UI Protocol v0.9” must not be treated as a compatibility test. Sources: [official message reference](https://a2ui.org/reference/messages/) and [official v0.9 specification](https://a2ui.org/specification/v0.9-a2ui/).

OpenUI Lang is a separate compact UI language, using named statements and component calls, conceptually:

```text
root = Stack([title])
title = TextContent("Quarterly results")
```

Component definitions determine the actual signatures. It combines a parser, component-library-generated prompt, rendering, and optional reactive behavior. It is not another spelling of Cognia's JSON. See [OpenUI architecture](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/docs/content/docs/openui-lang/architecture.mdx).

OpenUI now also ships [`@openuidev/a2ui`](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/packages/a2ui/README.md). The package explicitly describes an experimental A2UI v1.0 profile with **OpenUI Lang statement strings as component payloads**. Its strict versioned schema is not Cognia's `type` protocol, and its string component representation is not an ordinary A2UI JSON component catalog. Therefore “OpenUI supports A2UI” does not eliminate this migration boundary.

Offline checks confirmed both directions:

| Fixture                                            | Cognia parser                       | Published OpenUI A2UI 0.5.0 schema |
| -------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| Cognia `type: createSurface` envelope              | Accepted                            | Rejected                           |
| Official v0.9 JSON envelopes                       | Rejected                            | Rejected                           |
| OpenUI A2UI `v1.0` with Lang component strings     | Not Cognia's accepted message shape | Accepted                           |
| OpenUI `v1.0` envelope with JSON component objects | Not Cognia's accepted message shape | Rejected                           |

The OpenUI probe separately tests the payload representation under the correct `v1.0` version, so its rejection of JSON objects is not inferred only from the v0.9/v1.0 version difference.

## What the linked shadcn example proves

It demonstrates a useful design: define a component with `defineComponent`, supply its schema and description, assemble it with `createLibrary`, generate model instructions, and map streamed Lang output to React components. That can reduce the manually duplicated contract between allowed components and the model's prompt. See [library definitions](https://github.com/thesysdev/openui/tree/9823ec05d4b29bc78d101676dc16b44fe17f1830/examples/design-systems/shadcn/src/lib/shadcn-genui) and [official explanation](https://www.openui.com/docs/openui-lang/examples/design-systems/shadcn).

The current example is a complete chat demo: `AgentInterface` posts to a Next.js `/api/chat` handler, which uses the Thesys Gateway endpoint and `THESYS_API_KEY`; its sample business tools include mocked results. See [page](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/examples/design-systems/shadcn/src/app/page.tsx), [route](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/examples/design-systems/shadcn/src/app/api/chat/route.ts), and the upstream audit for tool details.

Cognia's established static-export architecture cannot directly host this dynamic API route. This constraint applies to copying the example, not to using the browser-side renderer. OpenUI's `lang-core` and `react-lang` can be integrated with Cognia's existing sidecar/companion inference transport; OpenUI Cloud and the example's chat shell are optional architectural choices. No static-export/Tauri compatibility build has yet validated that proposed integration.

Reusing Cognia's existing primitives also preserves its theme, accessibility, localization, and application context. A raw shadcn demo copy would require adapting these details again. The main gain comes from how UI is generated and interpreted, not from replacing one shadcn button with another.

## Benefits, limits, and current gaps

| Dimension                        | Assessment for Cognia                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progressive generation           | Strongest candidate gain. The Lang parser supports progressive structures/references. Cognia's fenced JSON extractor explicitly waits for a complete fence; however, Cognia already supports incremental MCP component/data batches, so it is incorrect to describe the whole subsystem as non-streaming                                                                                           |
| Output size                      | Likely useful on structurally verbose responses; must measure against Cognia's compact JSON and MCP tool path, including prompt/tool-schema overhead and repair turns                                                                                                                                                                                                                              |
| Contract maintenance             | Strong potential. Cognia currently maintains TS types, catalog names, renderer mappings, prompt prose, editor factories/properties, and permissive MCP component schemas separately. The audited catalog and renderer names currently agree; this is maintenance duplication, not evidence of present name drift                                                                                   |
| Runtime validation               | Cognia's message parser checks component IDs and component-name shape but accepts a Button without required `text`/`action` props. OpenUI's published core probe rejects missing required props and type mismatches, but accepts values violating `z.string().min(5)` and `z.number().min(10)`. Its structural checks are useful; they are not complete execution of every original Zod constraint |
| Visual quality                   | Conditional. Better library composition, descriptions, examples, layout constraints, and model choice can help. No controlled visual comparison was run; the language alone does not establish superior appearance                                                                                                                                                                                 |
| Interactive mini-apps            | OpenUI has richer reactive language facilities, but Query/Mutation execution needs host implementations. Existing Cognia actions, permission routing, and error/cancellation behavior still require integration                                                                                                                                                                                    |
| Persistence/editor compatibility | Significant work. Live Lang expressions are not equivalent to a snapshot of resolved JSON component values; a lossless bidirectional converter must not be assumed                                                                                                                                                                                                                                 |
| IM reach                         | Cognia already projects semantic trees into multiple platforms. A React-only switch loses that path unless new Lang surfaces have a defined semantic projection and text fallback                                                                                                                                                                                                                  |
| Native/security integration      | Need explicit action routing, PII gating, approved URL handling, cancellation/timeouts, and CSP/static-export verification. Safe component rendering does not authorize tools or external I/O                                                                                                                                                                                                      |

OpenUI can express state, Query/Mutation, and action wiring in the generated program, allowing later interaction to run through host tools without another model turn. Cognia already has local built-in handlers, so the gain is broader generated wiring rather than inventing local interaction. This matters more for new data-connected mini-apps than for a static dashboard. Host tools and their permission/cancellation policies remain application-owned.

One existing semantic inconsistency is relevant to any migration: the MCP schema describes `a2ui_update_components` as replacement, while the [store implementation](../../stores/a2ui/a2ui-store.ts) merges components by ID, and [AI editing guidance](../../lib/a2ui/generate-prompts.ts) explicitly requests patches. Decide and version the intended semantics before translating update messages. This audit did not change those semantics.

### Interpret the benchmark carefully

The [upstream benchmark methodology](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/benchmarks/README.md) describes seven saved scenarios. It generates Lang once, converts that AST into other formats, and compares artifact token counts. Its reported totals show approximately 52.8% fewer tokens than the chosen json-render serialization; the largest listed reduction is 67.1%. The documented latency estimate assumes a fixed 60 tokens/second.

This supports a representation-size advantage for those fixtures. It does not establish a measured reduction against Cognia, a model-independent reliability improvement, or a 3x end-to-end speedup. The comparison does not include Cognia's exact messages, its model routing, prompt/tool-schema input cost, tool execution, retries, first usable UI timing, Chinese prompts, or transport latency. Marketing tables comparing A2UI generally are not a substitute for this measurement.

## Integration options

| Option                                       | Scope                                                                                                                                             | Relative cost / outcome                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Improve existing A2UI                        | Consolidate component metadata, improve prompts/layout recipes, fix verified semantics, stream smaller MCP batches                                | Lowest integration cost; appropriate when the goal is visual polish or reliability rather than a new language                                                                           |
| OpenUI pilot for new generated chat surfaces | Use `react-lang`/`lang-core`, a small Cognia component library, existing model transport, and action adapters; preserve all current JSON surfaces | Recommended experiment; bounded work can measure the claimed benefits without migrating every subsystem                                                                                 |
| Lang to Cognia tree adapter                  | Translate a deliberately restricted Lang subset into the existing ID-based model and renderer                                                     | Can preserve current editor/IM investments, but conversion becomes owned code; expressions, queries, actions, identity, deletions, and partial nodes require a defined semantic mapping |
| Replace the entire subsystem                 | Migrate saved apps, chat parts, editor, history, SDKs, MCP/ACP, IM, workflows, native bridges, and tests                                          | Largest scope. Justified only after the pilot demonstrates enough benefit and the migration contract covers each boundary                                                               |

Avoid installing the full `react-ui` chat stack just to obtain a parser/renderer. Cognia already has its own conversation, message persistence, agent routing, and theme. Pin runtime and generated-library versions together, and check peers before adoption. OpenUI A2UI remains experimental even though Lang has a 1.x package version.

Two concrete dependency details reinforce that narrower choice. Published `react-ui@0.18.1` and `react-headless@0.18.1` require Zustand `^4.5.5`, whereas Cognia declares `^5.0.15`; `react-lang@1.0.1` has no Zustand peer. Lang uses positional component arguments derived from schema key order, so persisted Lang needs the matching library/signature version rather than only a package version. See the [upstream evolution guide](https://github.com/thesysdev/openui/blob/9823ec05d4b29bc78d101676dc16b44fe17f1830/docs/content/docs/openui-lang/evolution-guide.mdx) and the upstream audit's published metadata checks.

The audit also found development-time CDN-loaded inspection tools, opt-out installation telemetry, and opt-in server-runtime telemetry. Configure those behaviors deliberately for Cognia; they do not imply that ordinary browser rendering sends conversations to OpenUI. The upstream audit links the owning implementation. Likewise, the default A2UI URL opener and RPC wait lifecycle need application-specific URL policy and cancellation/timeouts. These are specific integration tasks, not evidence that the whole framework is unsafe.

## Proposed pilot and decision gates

These are proposed acceptance criteria, not completed work or measured targets:

1. **Define the product slice.** Start with new chat-generated comparison cards, forms, tables, and charts. Preserve existing mini-app and IM behavior. Record the content format and component-library version with each new surface, and keep old JSON readable.
2. **Reuse the host.** Define about 10–15 high-value components over Cognia's primitives. Use existing provider/model selection, redaction, cancellation, and transport. Connect button/form events to Cognia's action dispatcher. Give each surface one authoritative state owner; do not run two unsynchronized data models.
3. **Make behavior reviewable.** Cover Chinese labels, partial output, invalid props, unknown components, form editing/submission, permission denial, transport interruption, reload/replay, and safe text fallback. Do not enable general host queries or mutations until their mapping is explicit.
4. **Compare fairly.** Use the same task, component semantics, model, inference settings, and data. Repeat representative cases on at least a primary and a fallback model. Measure input plus output tokens, repair turns, first usable UI, completion p50/p95, semantic success, action round-trip, JS bundle growth, and render cost. Compare both existing fenced JSON and the existing MCP streaming path.
5. **Set the decision before measuring.** An example gate would require a meaningful reduction in total task cost or completion latency (e.g. 25% in the target slice), no regression in action correctness, and acceptable p95/fallback behavior. The exact threshold is a product choice, not an upstream guarantee.
6. **Expand only with a migration contract.** Before editor/IM rollout, require persisted-format fixtures, stable IDs, update/delete semantics, undo/redo, plugin registration, import/export, and platform projection tests. A snapshot that looks right is insufficient if it discards live logic.

## Verification performed

Current focused checks through the repository's Jest entry point:

```text
pnpm test --runInBand --runTestsByPath \
  lib/a2ui/parser.test.ts \
  lib/a2ui/catalog.test.ts \
  lib/a2ui/component-definitions.test.ts \
  lib/a2ui/pipeline-integration.test.ts \
  lib/a2ui/acp-bridge.test.ts \
  lib/connectors/a2ui-bridge/a2ui-to-segments.test.ts

Test Suites: 6 passed, 6 total
Tests:       327 passed, 327 total
```

Additional offline Cognia probe bundled the actual parser with the installed esbuild, without editing source:

- Local `createSurface`: 1 message accepted.
- Official v0.9 create/components/data envelopes: 0 messages accepted each.
- Simplified Cognia surface: 3 messages accepted (create/components/ready).
- Update with a Button missing required props: 1 message accepted, confirming shape-only validation at that boundary.
- Complete JSON inside a closed `a2ui` fence: 3 messages accepted; the same JSON inside an unclosed fence: 0.
- Standard catalog: 68 names; built-in renderer map: 68 names; no missing/extra names.

The upstream published-package schema probe ran in an isolated temporary directory, without installation scripts or dependency changes in Cognia. Its fixture results are summarized above and documented in the upstream audit.

No complete repository test suite, coverage, typecheck, build/export, UI benchmark, real model invocation, or native app flow was run. These are not needed to establish the inspected protocol mismatch, but remain necessary to accept an actual replacement.
