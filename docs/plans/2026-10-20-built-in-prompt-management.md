# Built-in prompts need one editor with resource-specific execution contracts

- Status: Accepted with the implementation revision in section 0; implemented by ADR-0236
- Date: 2026-10-20
- Author: Codex
- Depth: Heavy: UI, account data, workspace files, CLI/headless, packages, plugins, and runtime contracts
- Accepted scope: A complete management UI supporting editing and overrides, including explicit source-directory planning before implementation.
- Source baseline: `dev`, HEAD `279203e3d7f65fe7750595a38ff40931de003ec2`, plus current shared-worktree changes. Catalog counts and the two identified source patterns were rechecked for this revision.
- Evidence: [Agent comparison](../research/2026-10-20-agent-prompt-management-comparison.md) and [competitor source extraction](../research/2026-10-20-agent-prompt-management-comparison-sources.md). Official-source observations were collected on 2026-10-20; they are not competitor runtime acceptance results.

## 0. Implementation revision (2026-10-20)

The design below was checked against the code before implementation. Its resource semantics, owner adapters, P0 prerequisites and advanced-profile gates are kept. The following points were changed because the repository does not support the assumption they rest on; each change is recorded with its reason, so the rest of the document is read through it.

| #   | Plan statement                                                                         | Implementation decision                                                                                                                                                                                                                                                                                                                                                                                                                   | Reason                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Settings → AI & Agents → Prompts                                                       | Settings → Authoring → Prompts, beside Skills, Characters and Presets                                                                                                                                                                                                                                                                                                                                                                     | There is no AI & Agents group; the authoring group already holds every owner this editor delegates to.                                                                                                                           |
| R2  | Paired clients write prompts to the selected host and await a settled receipt          | The section is pinned to the `desktop` and `web-standalone` profiles. Standalone CLI and headless hosts manage the same store through `cognia-agent prompts` (list, show, set, reset, export, import).                                                                                                                                                                                                                                    | Companion sync is read-only host mirroring and no configuration entity has a mutating cross-device RPC. A prompt-only write channel would be the only one of its kind with no shared contract; portable profiles cover transfer. |
| R3  | Five negotiated activation modes with adoption receipts                                | Each definition declares its activation statically. Code templates resolve at their call and chat resources are re-read by the per-turn assembler (`next-operation`); external agent sessions that cache instructions are labelled `new-session-required`. The Prompt Center shows the last resolution per template.                                                                                                                      | No runtime produces adoption receipts, and every Cognia-owned consumer already re-resolves per operation. Claiming more would be the misreported active state the plan forbids.                                                  |
| R4  | Cross-device branching revisions with tombstone fencing                                | Optimistic concurrency per binding (`rev`), immutable revisions, inheritance tombstone on reset, 50 inactive revisions retained.                                                                                                                                                                                                                                                                                                          | The tables are not account-synced (the plan makes sync optional) so there is never a second writer to branch against.                                                                                                            |
| R5  | Effective preview of every loaded segment                                              | The base-selection rule is extracted from `build-options.ts` into a pure function shared by the assembler and the preview; the preview lists base, append setting, instruction files, mode and Skill metadata and labels runtime-generated sections as assembled at send time. Selection digests come from the fixed F1 path.                                                                                                             | Re-running `resolveSendOptions` for a preview mints gateway tickets and reads live state; a second assembler is explicitly out of scope.                                                                                         |
| R6  | Approval-sensitive judge profile activation policy to be defined                       | Custom command-judge guidance is narrow-only: a command is auto-allowed only when the shipped judge and the customized judge both call it safe; cache keys include the prompt digest.                                                                                                                                                                                                                                                     | Satisfies "custom verdicts alone must not widen authority" without a policy review loop that does not exist.                                                                                                                     |
| R7  | Register every inventoried prompt                                                      | Dead or test-only code is deleted instead of registered: the A2UI form/dashboard/choice/wizard/feedback builders and `A2UI_TEMPLATES`, `summarizeConversation` and `generateAICompressionSummary`. RAG LLM grounding has no root-app caller and is excluded. Machine-read protocol text (loop trailer, A2UI protocol, subagent frame) is inspect-only.                                                                                    | Editing an entry with no consumer is the dormant control acceptance A16 rejects; protocol text consumed by a parser is a host contract (section 3.1).                                                                            |
| R8  | Centralized PII check of override text at each owning boundary                         | The resolver refuses an override whose body fails `hasNoLeakingPii` and falls back to the shipped body, in addition to every existing call-site gate.                                                                                                                                                                                                                                                                                     | Several call sites gate only interpolated data, not the system text; one check at selection covers every slot without depending on call-site coverage.                                                                           |
| R9  | Generate portable prompt data or pass a resolved override to the Rust bootstrap        | One slot per bootstrap runtime (`developer.bootstrap.{native,bash,powershell}`), each default pinned by a test to that runtime's own text; the launcher passes an override through the existing `systemPrompt` field only when one is published, and an environment's own prompt wins. The terminal-only `chat` persona is not a slot.                                                                                                    | The three runtimes ship different defaults and none loads TypeScript; passing nothing without an override keeps each default byte-identical, and the app never starts the `chat` mode.                                           |
| R10 | Adapt first-party plugins explicitly; later SDK contributions versioned and namespaced | `ctx.prompts` (`register`, `resolve`; frontend, hybrid, Python) declares plugin wording as `plugin:<pluginId>/<id>` slots with host-assigned authority; Deep Research declares its five instructions. Plugin subagent prompts are account-scoped slots resolved on every dispatch rail; plugin modes are listed with custom modes and copied losslessly. A disabled plugin's overrides are listed as unavailable, exported and removable. | Plugin code cannot import the resolver (ADR-0155). A subagent-template copy would drop `effort` and `disallowedTools`, widening what the copy may do; a mode copy loses nothing.                                                 |
| R11 | Character/mode/subagent and team packs edited through their owners                     | Subagent templates and Agent Team templates have owner adapters: the user's own are saved in place (team writes mirrored to the template platform that Use instantiates), seeded and plugin ones through whole-template copies.                                                                                                                                                                                                           | Both stores were editable only on their own screens; the Prompt Center would otherwise omit user-owned role prompts.                                                                                                             |
| R12 | Register every inventoried prompt                                                      | The terminal AI Shell's prompts are not registered.                                                                                                                                                                                                                                                                                                                                                                                       | The AI Shell panel is not mounted anywhere; a slot for it would be a dormant control (A16). Registering waits until the feature is wired or removed.                                                                             |

## 1. Deliver the complete editor while preserving each resource's meaning

**Recommendation:** build one Prompt Center for discovery, source editing, custom versions, scoped overrides, effective preview, history, reset, import/export and upgrade conflicts. Preserve the existing owners of project files, characters, Skills, presets and plugins. Share management contracts without forcing every resource through one text-replacement or storage mechanism.

The comparison supports explicit distinctions among runtime baselines, additive rules, role identities, on-demand procedures and feature templates. Several agents permit full replacement; the design must explain its effect rather than prohibit it or silently apply it. A single directory of strings or a generic account/workspace/session precedence order does not establish equivalent execution across these resources.

Published configuration and the revision actually active in a running session are separate states. Every edited entry must expose its source, operation, applicability, compatibility and activation requirements. Existing saved replacement behavior is preserved until explicit conversion; ordinary new persona customization should normally augment a known baseline. Hidden upstream instructions remain outside Cognia's control and visibility.

Before the inspector can claim what executed, implementation must correct composition hashing that omits appended text and subagent framing that trusts an editable marker. These fixes are prerequisites in P0, not changes made by this document. Reuse existing delivery/budget logic and extend existing modules first; a new shared package is conditional on independent consumers needing it.

### 1.1 Goals map directly to observable behavior

| Goal                                 | Completion evidence                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 Complete management               | Search, edit, validate, publish/save, inspect active state, compare, restore and reset work through real owner adapters for every agreed first-party cohort. |
| G2 Source integrity                  | Each active body has one authority; repository resources remain files, domain resources remain owner records, bundled defaults remain immutable.             |
| G3 Correct runtime behavior          | Operation, scope, permissions, supported model/runtime/tool contract and activation mode are explicit; edits reach their actual consumer.                    |
| G4 Trustworthy inspection            | Selection identity and final translated request identity are distinct; provenance covers all visible segments and labels hidden/unknown content.             |
| G5 Controlled cost and compatibility | On-demand resources stay on demand; budgets, omissions, result-cache versions, migration and behavior-specific validation are enforced at their owners.      |
| G6 Cross-host usability              | Connected clients use their selected authoritative host; independent stores exchange explicit portable profiles without being silently conflated.            |

Scope includes shipped first-party model-facing definitions/templates and editable project/user instruction resources. Third-party entries are supported through declared versioned capabilities, without rewriting arbitrary plugin code. File-backed rule editing and the advanced profile cohort are part of the full feature; an index-only intermediate state is not completion.

Non-goals are a hosted prompt SaaS, mandatory online fetch, a general template programming language, automatic modification of provider-internal prompts, turning tool schemas or authorization code into editable prose, and a claim that natural-language precedence or fixture passing guarantees model compliance. Automatic account-device sync is optional; local/host persistence and portable import/export are required.

## 2. The current system has several catalogs and several assembly paths

### 2.1 Confirmed catalog sizes do not describe the total prompt count

The following counts were measured from current sources on 2026-10-20:

| Catalog                         | Count | Counting boundary                                                                         |
| ------------------------------- | ----: | ----------------------------------------------------------------------------------------- |
| Built-in session presets        |    12 | `preset_builtin_*` definitions in `lib/db/preset-built-ins.ts`                            |
| First-party built-in characters |     7 | Character definitions in `plugins/cognia-builtin-characters/src/index.ts`                 |
| Built-in agent modes            |    11 | Entries in `BUILT_IN_AGENT_MODES`; some have no prompt                                    |
| Shared built-in subagents       |     8 | Four core identities plus four workflow entries in `lib/agent/builtin-catalog/catalog.ts` |
| File-authored built-in Skills   |    14 | `skills/built-in/*/SKILL.md`; not the entire seeded Skill inventory                       |
| Router Fusion role documents    |     9 | Eight roles plus the common document in `packages/router-fusion/src/prompts/`             |

A separate heuristic scan found **158 candidate source files** across `lib` (100), `packages` (18), `plugins` (17), `components` (9), `cli` (6), `crates` (4), `hooks` (2), `types` (1), and `sidecar` (1). It scanned TS/TSX/Rust/Python/MJS for prompt constants, literal system/instruction fields, or model identity phrases, excluding standard test/story/vendor/fixture paths. This intentionally includes false positives, comments, example data, and consumers; it misses other wording and Markdown. **158 is a search worklist, not a count of prompts, registered definitions, or reachable model calls.** No complete runtime coverage claim is made.

The measured catalogs overlap conceptually. A Coding Assistant character and a Code Expert preset can have similar text while retaining different identities, lifecycle, and application semantics. Do not merge them merely because text is similar.

### 2.2 The source inventory has different persistence and execution owners

All paths below are current sources. Proposed paths appear only in later sections.

| Family                                | Definition / builder                                                                                                                                                                                                                                               | Current consumption or lifecycle                                                                                                      | Management implication                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Session presets                       | [preset-built-ins](../../lib/db/preset-built-ins.ts), [prompt-presets](../../lib/db/prompt-presets.ts)                                                                                                                                                             | Seeded into `promptPresets`; built-ins reject content updates/deletes; duplication produces custom rows; default selection is allowed | Keep preset IDs and CRUD semantics; offer a custom copy and an explicit default-replacement binding                      |
| Characters                            | [built-in character plugin](../../plugins/cognia-builtin-characters/src/index.ts), [characters DB](../../lib/db/characters.ts)                                                                                                                                     | Plugin overlays, clones/variants, pristine snapshots, selective Apply Update                                                          | Reuse character variants and update comparison; do not introduce a competing prompt-body store                           |
| Modes                                 | [agent-mode](../../types/agent/agent-mode.ts), [app-preset-catalog](../../lib/agent/composition/app-preset-catalog.ts)                                                                                                                                             | Built-ins, custom and plugin modes feed the effective composition and send options                                                    | Preserve mode identity and permission/tool settings; text editing does not edit those settings                           |
| Subagents                             | [builtin catalog](../../lib/agent/builtin-catalog/catalog.ts), [shared child frame](../../lib/claude/agents/subagent-prompt-frame.ts)                                                                                                                              | Identity text plus runtime environment and delegation contract; workflow identities remain in their own modules                       | Edit identity separately from the host-owned frame; retain agent IDs, tool policy and surfaces                           |
| CLI default                           | [default-system-prompt](../../cli/src/config/default-system-prompt.ts), [to-build-context](../../cli/src/config/to-build-context.ts)                                                                                                                               | Default base only when config does not supply a prompt; cwd/date/shell are runtime inputs                                             | Edit the template, not a rendered copy containing a historical cwd/date                                                  |
| Skills                                | [built-in source directory](../../skills/built-in), [build script](../../scripts/build/build-builtin-skills.mjs), [skills DB](../../lib/db/skills.ts), [catalog loader](../../lib/skills/built-in-catalog.ts)                                                      | Markdown sources generate metadata/body/resource chunks; runtime chooses delivery mode and resources                                  | Reuse build generation, custom copies and resources; preserve delivery, capability, and host-policy metadata             |
| Main chat assembly                    | [build-options](../../lib/claude/build-options.ts)                                                                                                                                                                                                                 | Resolves base, persona, instruction files, workspace, memory, knowledge, modes, Skills, and later append fragments                    | Instrument the existing assembler; do not build a second universal chat stack                                            |
| Project instruction files             | [instructions modules](../../lib/claude/instructions), [workspace instructions](../../lib/workspace/workspace-instructions.ts)                                                                                                                                     | Layered/nearest discovery and imports; different filesystem availability across hosts                                                 | Edit canonical files through checked workspace writes; preserve discovery/import and source trust                        |
| Titles, summaries and Canvas actions  | [title](../../lib/ai/generation/title.ts), [summarizer](../../lib/ai/generation/summarizer.ts), [canvas-actions](../../lib/ai/generation/canvas-actions.ts)                                                                                                        | Utility calls use dedicated prompts/builders; the conversation-summary prompt is already shared with compaction                       | Register existing templates and resolve before the owning call; keep sanitizers, budgets and fallback behavior           |
| Completion and prompt polish          | [ghost-prompt](../../lib/chat/completion/ghost-prompt.ts), [enhance](../../lib/chat/completion/enhance.ts), [terminal completion](../../lib/terminal/completion/prompt.ts)                                                                                         | Different constrained outputs and context limits                                                                                      | Declare per-entry output contracts and editable slots                                                                    |
| Agent planning and continuation       | [goal prompts](../../lib/goal/prompts.ts), [loop prompts](../../lib/loop/prompts.ts), [plan prompts](../../lib/agent/plan/prompts.ts), [plan-mode prompt](../../lib/claude/plan-mode-prompt.ts)                                                                    | Dynamic goal/plan data and continuation/judge protocol                                                                                | Separate stable wording from live plan state and machine-readable completion trailers                                    |
| Team orchestration                    | [auto planning](../../lib/ai/agent/team/auto), [lead review](../../lib/ai/agent/team/squad/lead-review.ts), [teammate character](../../lib/ai/agent/team/teammate/teammate-character.ts)                                                                           | Per-role planners, reviewers, defaults, task data and progress ledgers                                                                | Resolve per role under a run-frozen revision set                                                                         |
| Digital twin and pet                  | [twin template](../../lib/twin/runtime/system-prompt-template.ts), [distillation prompts](../../lib/twin/distill/prompts.ts), [pet persona](../../lib/pet/llm/persona.ts)                                                                                          | Identity, private entities/voice, retrieval and few-shot data; stable/dynamic segments                                                | Edit scaffolding separately from profile data; avoid persisting private rendered previews                                |
| A2UI and visual output                | [A2UI prompts](../../lib/ai/prompts/a2ui-prompts.ts), [visual-output prompts](../../lib/ai/prompts/visual-output-prompts.ts)                                                                                                                                       | Capability-gated fragments and catalog instructions appended to turns                                                                 | Preserve capability gates and tool-dependent conditions                                                                  |
| Wiki, Radar, Git and issue assistance | [wiki](../../lib/wiki/prompts.ts), [radar](../../lib/radar/prompts.ts), [Git review](../../lib/git/ai-review.ts), [issue assistance](../../lib/issues/ai-issue-assist.ts)                                                                                          | Feature-owned model calls, data wrappers and output expectations                                                                      | Add descriptors and feature-owned integration tests rather than copying calls into the center                            |
| Package-owned AI helpers              | [memory extraction](../../packages/memory/src/extract/extractor.ts), [RAG grounding](../../packages/rag/src/answer-grounding.ts), [eval judge](../../packages/eval-core/src/scorers/judge.ts), [search answer](../../packages/web-search/src/standalone-answer.ts) | Shared packages cannot import the root app's DB/UI; some construct prompts inline                                                     | Inject an optional resolved-prompt provider with built-in defaults; no root-app dependency                               |
| Router Fusion                         | [roles](../../packages/router-fusion/src/prompts/roles.ts), [role fixtures](../../packages/router-fusion/src/prompts/roles.test.ts), [action catalog](../../packages/router-fusion/src/config/builtin-catalog.ts)                                                  | Markdown and embedded strings are checksum-pinned; prompt version participates in action identity                                     | Customization creates a separate profile/version and action identity; never mutate `roles-1` in place                    |
| Permission judgment                   | [command judge](../../lib/claude/permissions/command-judge.ts)                                                                                                                                                                                                     | Model output participates in unattended-command decisions; failures return `null` to the caller                                       | Treat activation as behavior affecting approvals, not cosmetic editing; parser validation alone does not prove safety    |
| First-party plugins                   | [Deep Research](../../plugins/deep-research/src/engine/prompts.ts), [work mode](../../plugins/cognia-work-mode/src/mode.ts), character/team/subagent packs                                                                                                         | Plugin-owned definitions, availability and lifecycle                                                                                  | Adapt shipped first-party plugins explicitly; later SDK contributions must be versioned and namespaced                   |
| Rust bootstrap                        | [runner](../../crates/cognia-bootstrap-agent/src/runner.rs), [conversation](../../crates/cognia-bootstrap-agent/src/conversation.rs)                                                                                                                               | Rust contains its own default model-facing prose and accepts configured text in relevant paths                                        | Generate portable prompt data or pass a resolved override through the owning launcher; do not import TS at runtime       |
| User composer templates               | [prompt-template plugin](../../plugins/prompt-templates/src/index.ts), [template store](../../plugins/prompt-templates/src/template-store.ts)                                                                                                                      | Namespaced plugin storage; inserts verbatim text into the composer                                                                    | A related user-message resource, not a built-in system-prompt registry; show a linked category without migrating storage |

### 2.3 Existing assembly establishes precedence that must be preserved

The normal chat base uses nullish precedence, as implemented in `build-options.ts`:

```text
session.systemPrompt
  ?? team-member.systemPromptOverride
  ?? character.systemPrompt
  ?? appSettings.defaultSystemPrompt
```

This is selection of one base, not concatenation of every base. An explicit empty string and an absent value are different. A preset can populate session configuration through [apply-to-session](../../lib/presets/apply-to-session.ts); it is not automatically an extra prompt layer.

The base then gains persona, discovered instructions, workspace context, memory, continuity, knowledge, mode, and Skills. Later conditional blocks add A2UI/visual guidance, team protocol, sandbox hints, Plan/brief/output-style guidance, compaction recovery, goals/plans, and dynamic context. The twin can replace the base. Workflow Copilot and aside sessions have dedicated prompt behavior. A universal global replacement applied at the final string would erase these semantics.

CLI's [session-context](../../cli/src/agent/session-context.ts) deliberately uses `toBuildContext → resolveSendOptions` for both built-in and external backends. Its default coding identity is still CLI-specific. Standalone utility calls do not all traverse that assembly. [external-agent-instruction-stack](../../lib/ai/instructions/external-agent-instruction-stack.ts) is explicitly deprecated and reports no production caller; it must not become the new resolver.

Provider translation is another boundary: [composeSystem](../../lib/ai/agent/agent-executor.ts) joins strings, [partitionPrompt](../../lib/ai/prompt-partition.ts) preserves leading/interleaved message order and per-block provider options, and the sidecar's [foldSystemPrompt](../../sidecar/src/runtimes/claude-agent-sdk/system-prompt.ts) preserves SDK custom/preset shape and stable/dynamic parts. Registration does not replace these adapters.

### 2.4 Shared code does not mean shared persisted overrides

GUI uses its account database. CLI's [DB bootstrap](../../cli/src/db/bootstrap.ts) reuses the Dexie layer through a Node IndexedDB shim and its own persistent snapshot/store, with a single-writer lock and deliberate read-only followers. CLI and GUI therefore need explicit transport or import to share changes.

Account sync's [table policies](../../lib/account-sync/data/tables.ts) currently list sessions, messages, characters, Skills, memories and settings. Built-in character/Skill rows are excluded; this is not an automatic sync channel for a new override table. [Data governance](../../lib/data-governance/table-catalog.ts) separately defines backup, companion mirroring, account E2E sync, retention and deletion. New prompt data must be classified there.

### 2.5 Existing mechanisms solve parts of the problem, not unified management

Confirmed reusable pieces include the preset editor, character variant/update machinery, built-in Skill generation and lazy resources, settings navigation, provider adapters, content digests, and encrypted evaluation assets. [Character Apply Update](../../lib/plugin/character-pack/diff-pack-update.ts) already preserves changed fields against a pristine baseline, although its legacy no-baseline behavior must not be copied as a default overwrite policy for new prompt revisions.

[Model-request shadow events](../../lib/ai/replay/model-request-shadow.ts) carry digests/references, and [composition digests](../../lib/agent/composition/digest.ts) identify content. They do not provide a catalog of individually editable prompt entries or a complete all-provider prompt inspector. Extending provenance is useful; widening those events to raw text would violate their current contract.

**Inference:** the missing capability is a common identity, edit lifecycle, resolution contract and management read model across these owners. A new all-in-one string file or reuse of the composer-template plugin would leave that gap.

## 3. Give each resource an explicit owner, operation and authority boundary

### 3.1 Use different composition operations behind the common editor

| Resource kind              | Canonical owner                                        | Allowed composition/edit operation                                                                          | Required boundary                                                                                                          |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Runtime baseline           | Runtime/adapter and its bundled defaults               | Explicit `replace-baseline` custom profile where supported; default export/impact comparison when available | Show which operational guidance is replaced; compatibility includes runtime/model family and tool contract.                |
| Project/user rule          | Workspace file or the existing user-instruction owner  | `append-rules`; edit the owning source and preserve its discovery/import order                              | Applicable files can coexist. Scope specificity is not permission authority or deterministic semantic conflict resolution. |
| Role/persona               | Character, mode or subagent owner                      | `add-role` for supported new definitions; explicit `legacy-replace` or advanced replacement where required  | Host environment, delegation frame, tool grants and policies are assembled separately from editable identity.              |
| Skill/procedure            | File bundle, domain bundle or plugin                   | `activate-procedure`; edit/custom-copy the bundle                                                           | Preserve metadata, trigger, delivery, resources, capability requirements and invocation policy.                            |
| Feature template           | Owning title/summary/Canvas/twin/goal/team/etc. module | `replace-template` or an explicitly declared append slot                                                    | Keep typed inputs, clipping, output parser, schema and dynamic data injection in the owner.                                |
| Composer template          | Existing prompt-template plugin                        | Insert user-authored content through the composer owner                                                     | It remains user-message content, not an automatic system instruction.                                                      |
| Host contract/runtime data | Executable host policy and feature builders            | Inspect declared provenance; customize only a separately declared text slot                                 | Editing cannot forge host framing, grant permissions, change budgets, or make retrieved task data a trusted instruction.   |

Each entry declares supported operations; the editor never infers replacement from a field named `systemPrompt`. A runtime that cannot preserve a baseline while adding a role reports that limitation. It must not silently implement an additive edit as a full custom-prompt replacement.

For existing sessions/characters, preserve the current nullish base selection recorded in section 2.3. A conversion from `legacy-replace` to `add-role` is a separate previewed migration. Intentional P0 correctness fixes have explicit regression expectations rather than pretending the old defective output is a compatibility invariant.

### 3.2 Extend metadata only where a shared contract is missing

Proposed `PromptDefinitionV1` describes management and compatibility; it does not grant execution authority:

| Contract group  | Fields / validation                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | Stable namespaced `id`, definition version, body digest, localized label/description, owner and actual consumers                                          |
| Resource/source | `resourceKind`, `sourceKind`, source reference, source/authority class and edit policy; authority is host-assigned, never trusted from plugin/import text |
| Composition     | Supported operation, editable slots, stable/dynamic placement and whitespace/empty-value behavior                                                         |
| Applicability   | Allowed scope/target kinds, trigger/delivery policy, capability requirements, supported runtime/model family/tool-contract versions                       |
| Activation      | Per-runtime activation mode and versioned capability declaration; published and active revision references are separate                                   |
| Contract/budget | Allowlisted typed variables and limits, output validator identifier, contract version/digest, required segments and budget policy                         |

IDs such as `generation.title.chat`, `agent.builtin.Explore.identity`, `cli.base`, and `plugin:<plugin-id>/<entry-id>` identify resources. Display names and text similarity do not merge identities. File-backed identity includes the owning workspace and normalized source path so worktrees do not share an accidental binding; renames require an explicit mapping, not text-based guessing.

Reuse the built-in Skill generation/lazy-loader pattern for bundled metadata and bodies. Indexing must not import React, DB, Node filesystem or activate plugins. Duplicate IDs, unresolved body references, unsupported schema versions and unknown validator IDs fail build/registration checks. Repository discovery is a runtime workspace concern, not a build-time enumeration of the user's files.

Create a narrowly scoped app management entry at `lib/prompts/` for the common catalog/read model, owner adapters and eligible-slot resolution; keep authored bodies with the owners below. The existing `lib/ai/prompts/` contains AI output instructions, so expanding it into filesystem/DB/host management would mix responsibilities. This separation justifies the new directory, not a new copy of domain logic. Extract a pure shared package only when concrete independently built consumers require it, with build/pack tests. Package APIs can accept an optional resolved-prompt provider without root-app imports. Directory reorganization itself does not require a new package or database schema.

### 3.3 Reorganize source responsibilities and keep one management entry

**Recommendation:** centralize the management entry and inventory, while locating authored resources by ownership. Several current paths mix runtime data with types/persistence or place host-independent agent guidance under a provider name. Reorganize those specific cases; do not relocate every feature prompt into a global body repository.

The following is a target layout. New paths are **proposed**, not modules created by this task; existing paths without a relocation entry retain their current ownership.

```text
lib/
  prompts/                          app management, not all authored prompt bodies
    types.ts                        management/read-model contracts
    catalog.ts                      compose existing owner catalogs and source references
    resolve.ts                      eligible-slot selection and provenance
    adapters/                       file, domain, plugin and feature-owner adapters
  agent/
    builtin-catalog/                shipped identities and their domain registry
    modes/built-ins.ts              mode definitions and runtime lookup helpers
    prompts/
      plan-mode.ts                  shared Plan guidance
      subagent-frame.ts             host-independent environment/delegation framing
  presets/built-ins.ts              shipped session preset definitions
  ai/
    generation/                     title/summary/Canvas feature owners and builders
    prompts/                        genuinely shared AI output guidance
  a2ui/prompts.ts                    A2UI protocol guidance beside its catalog/builders
  workflow/editor/copilot-prompts.ts workflow-editor Copilot owner
  <feature>/prompts.ts              local goal/loop/wiki/radar/etc. definitions/builders
  db/
    prompt-presets.ts               preset persistence/seeding, not authored defaults
    prompt-overrides.ts             generic revision persistence when that cohort needs it

components/settings/prompts/         Prompt Center views and editor orchestration
generated/prompts/                   generated management metadata/lazy body references
scripts/build/                      catalog generation/checks alongside existing generators
skills/built-in/<skill>/             canonical Skill Markdown, resources and assets
plugins/<plugin>/src/                plugin-owned definitions and prompt resources
packages/<package>/src/              independently built package-owned prompts
cli/src/config/                     CLI-only default/environment prompt builders
sidecar/src/runtimes/<runtime>/      provider/runtime translation
```

The management catalog composes references to existing owners; it is not a second authority for the list of shipped agents, mode settings, Skill triggers or plugin availability. Add a generated management index only when needed for static/lazy loading. It derives IDs/digests/references from those owners, contains no user/account/runtime text, and is never edited manually.

### 3.4 Migrate misplaced sources without changing IDs or runtime meaning

| Current source                                                       | Target / action                                                                                                                    | Reason and preservation rule                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types/agent/agent-mode.ts`                                          | Move built-in definitions and runtime lookup helpers to `lib/agent/modes/built-ins.ts`; retain type definitions in the type module | Types should not own editable runtime catalogs; preserve mode IDs, helpers, order and SDK public exports. Existing shared permission vocabulary in `packages/agent-config-types/src/agent-modes.ts` is a different contract and stays there. |
| `lib/db/preset-built-ins.ts`                                         | Move definitions/builder to `lib/presets/built-ins.ts`; DB CRUD/seeding imports it                                                 | Persistence consumes domain defaults; preserve all `preset_builtin_*` IDs and timestamp/seeding behavior.                                                                                                                                    |
| `lib/claude/plan-mode-prompt.ts`                                     | `lib/agent/prompts/plan-mode.ts`                                                                                                   | Already shared by GUI and CLI; placement should not imply a Claude-only contract. Preserve text and exports.                                                                                                                                 |
| `lib/claude/agents/subagent-prompt-frame.ts`                         | `lib/agent/prompts/subagent-frame.ts`                                                                                              | Host-independent child framing belongs with agent contracts; migrate alongside, but distinguish from, the F2 behavior fix.                                                                                                                   |
| `lib/claude/agents/workflow-copilot-prompt.ts`                       | `lib/workflow/editor/copilot-prompts.ts`                                                                                           | Workflow identity/tool guidance belongs to the workflow editor; runtime dispatch/adapters still own transport.                                                                                                                               |
| `lib/ai/prompts/a2ui-prompts.ts`                                     | `lib/a2ui/prompts.ts`                                                                                                              | Place A2UI guidance with its feature catalog/builders; keep cross-feature visual routing in `lib/ai/prompts/visual-output-prompts.ts`.                                                                                                       |
| `plugins/cognia-builtin-characters/src/index.ts`                     | Extract pack/character definitions into that plugin's `src/characters.ts`; entry point imports them                                | Separate registration from authored definitions within the same plugin. Keep pack/local IDs and update attribution; do not create a parallel core character catalog.                                                                         |
| Feature-local generation/goal/loop/twin/wiki/radar prompts           | Keep with existing feature; extract inline constants into adjacent `prompts.ts` only when needed for safe indexing or shared use   | A single short constant does not justify a new directory/file; dynamic builders stay typed and local.                                                                                                                                        |
| Package/plugin prompts, file-authored Skills and Router Fusion roles | Keep within their existing distributable source/bundle boundary                                                                    | No package imports root management/DB modules. Router role checksum/version contracts stay intact; their current TS/Markdown copies are not declared generated until a checked generation change actually exists.                            |
| CLI environment/default and sidecar prompt folding                   | Keep runtime-specific code in its current host/runtime boundary                                                                    | Only proven shared fragments move to `lib/agent/prompts/`; moving content must not blur provider translation or CLI operating rules.                                                                                                         |

Use short pure TypeScript definitions for compact catalogs and typed builders; retain existing Markdown formats for Skills/long packaged prose. Convert long text to Markdown only with a supported build-time loader and byte-parity checks. Never add runtime Node filesystem access or mandatory HTTP fetch for web/static consumers. Do not create one module per sentence or require all templates to use one format.

Relocation is a source-only migration: keep persisted resource IDs, plugin IDs, mode IDs and public SDK export paths stable; update source references without regenerating identities from new code paths. File-backed user resource identity/rename behavior remains governed by its workspace owner. No Dexie migration is needed merely because a source module moves.

Migrate a small owner group at a time, moving its co-located tests and direct imports. Where SDK/public consumers need compatibility, use temporary explicit re-exports and record their removal in P5; no duplicated definitions or side-effectful barrels. Check generators, build aliases, package exports and packed CLI/sidecar artifacts as well as app imports. Verify byte/shape parity for relocation separately from intentional F1/F2 fixes, so failures have an identifiable cause.

The large existing `lib/claude/build-options.ts` assembler remains the runtime integration seam in this scope. Extracting shared prompt fragments does not authorize a broad rename/rewrite of that assembler or all `lib/claude/` modules. Directory relocation alone is not delivery: each moved definition must still reach its actual consumer and the management index.

## 4. The UI shows source, edit intent and actual activation

Add the proposed **Settings → AI & Agents → Prompts** entry through the existing settings shell. Preserve existing character/Skill/preset entry points and share their owner write services. Group the catalog by resource kind, with separate advanced baseline/protocol views, rather than presenting every string as interchangeable.

| Surface           | Required behavior                                                                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog           | Search metadata and bodies on demand; filter kind, source, host/runtime, scope, modified state, availability and conflicts. Metadata and bodies load separately.                                                                                                        |
| Detail            | Show purpose, canonical source, shipped/default/custom content, operation, consumers, variables, delivery/trigger, output contract and compatibility.                                                                                                                   |
| Editor            | Edit owning file or custom/domain version, preserving formatting; compare source/default/custom versions; validate inputs; distinguish save draft, save source and publish binding.                                                                                     |
| Target/scope      | Offer only eligible account/workspace/agent/session targets. Show authority restrictions separately; never target whichever chat/workspace happens to be visible.                                                                                                       |
| Active state      | Show saved/published revision, active revision for the selected context, pending changes, activation mode and why an entry is inactive or unsupported.                                                                                                                  |
| Effective preview | Show ordered loaded segments and their provenance, discoverable/on-demand entries, omitted entries with reasons, stable/dynamic split and estimated size. Label layer preview, next-operation preview, last-operation evidence and unknown upstream content distinctly. |
| History           | Compare revisions and upstream changes; restore as a new revision/source write. Show file/Git history or history availability honestly; no claim of transactional DB history for unmanaged filesystem changes.                                                          |
| Reset             | Preview the resulting inherited/default content. Remove only the selected override; file reset is an expected-content source write and preserves unrelated sections.                                                                                                    |
| Portability       | Import/export static custom definitions, bundles and bindings with versions and target mappings. Preview conflicts/redactions/activation; never execute imported code or overwrite repository files without an explicit selected target.                                |
| Evaluation        | Run deterministic preview/contract checks locally first. Explicit model testing uses the existing provider/eval path and shows provider/input/cost context; navigating, saving and publishing do not themselves call a model.                                           |

Examples: a title template can choose a more specific eligible workspace binding; a character uses a custom domain variant and an explicit operation; an `AGENTS.md` edit writes that file; a Skill edit preserves its bundle and delivery metadata. “Use this custom copy by default” changes a binding separately from the body edit.

Mobile uses list → detail → editor navigation. Paired clients write to the selected authoritative host and await a settled receipt; offline drafts cannot claim activation. Standalone clients edit their local supported owners. Keyboard navigation, focus, unsaved-change handling, loading/empty/error/offline states, accessible labels and English/Chinese split locales are required. Use existing text/editor/diff components, lazy-loading Monaco only where useful.

Advanced profile editing remains part of the final scope. Drafting a baseline, routing or judge customization does not activate it. Unsupported activation has a precise status; no inert publish control is counted as delivery.

## 5. Keep files and domain records authoritative; add generic revisions only for code-only slots

The common read model delegates writes and resolution to resource owners:

```text
Bundled defaults        Workspace files        Existing domain/plugin rows
       |                       |                         |
       +---------- catalog + source/owner adapters ------+
                                  |
                           Prompt Center
                                  |
               validate + save source / publish binding
                                  |
               applicability + operation-specific selection
                                  |
                 existing builders and runtime activation
                                  |
             provider translation + outbound gate + digest
                                  |
                         model / external runtime
```

Conclusion: the editor unifies management while each source remains authoritative and runtime builders retain live context and policy.

### 5.1 Owner adapters expose capabilities instead of pretending all writes are the same

| Ownership                         | Write/history/reset path                                                                                                             | Authority invariant                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Repository instruction/Skill file | Existing workspace read/write APIs, expected-content check, explicit source save and loader invalidation; Git history when available | The file/bundle is canonical; drafts/index caches are not an authoritative DB mirror.           |
| Built-in Skill bundle             | Custom copy/overlay through the existing Skill owner; preserve resources, frontmatter and selection                                  | Bundled/generated output stays immutable; a user-selected custom bundle has its existing owner. |
| Character/mode/subagent           | Existing custom clone/variant or supported definition file, with operation metadata                                                  | No second generic active `systemPrompt` value for the same owner field.                         |
| Preset                            | Existing editable custom preset plus explicit default/session binding                                                                | Preserve seeded IDs, CRUD semantics and the difference between text editing and selection.      |
| Composer template                 | Existing plugin storage/API                                                                                                          | Keep the plugin namespace and user-message insertion behavior.                                  |
| Code-only feature/template slot   | Generic revision and scoped binding store                                                                                            | Only resources without an existing editable source use the new active-body store.               |

Adapters provide capability-aware `read`, `validate`, `saveDraft`, `saveSource`/`publish`, `reset`, `history` and `activationStatus`. Existing screens call the same owning mutation services. Domain history records a consistent version with its owning write rather than maintaining a competing active copy.

File operations use the selected execution workspace/root and existing trust/path controls, including symlink/root escape protection. Reuse [readWorkspaceFileVersioned and writeWorkspaceFileChecked](../../lib/files/workspace-fs.ts), including expected SHA-256/absent-file preconditions and typed conflicts; do not add an unchecked write path. A write carries the expected content digest; a watcher-detected change causes a conflict rather than silent overwrite. Preserve multi-root/worktree identity, permitted native/remote writes, encoding and line endings. Read-only or missing filesystem capabilities disable source writes while retaining drafts/export. Reset/restore obey the same checks. A multi-file bundle save exposes per-file receipts and revalidates the complete bundle; it is not advertised as an all-or-nothing filesystem transaction unless the owner provides that guarantee. Runtime operations snapshot a validated bundle and do not mix revisions during a call. File history uses Git where available and locally preserved pre-edit recovery content for editor writes; external filesystem edits have only the history the underlying source provides.

Portable imports map source references to an explicitly selected owner/root; they never trust an exported absolute path. Plugin uninstall makes its resources unavailable and preserves exportable custom work according to the owner's deletion policy.

### 5.2 Generic revisions are immutable; bindings publish atomically

Propose two account-scoped tables only for code-only entries; no Dexie version is reserved here:

| Table                     | Proposed fields and invariant                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptOverrides`         | Binding ID; prompt ID; normalized eligible scope/target; active published revision or inheritance/tombstone; concurrency revision. Compound uniqueness on prompt/scope/target within the owning account DB.               |
| `promptOverrideRevisions` | Immutable ID and parent; binding; body/operation; draft or published revision kind; base body/digest/version; contract version/digest; author/device reference; timestamp; validation evidence. No rendered runtime data. |

Autosave writes a new draft revision. Publishing creates a validated published revision and switches the active pointer in one transaction using the expected concurrency revision; immutable revision records are not edited in place. Reset publishes inheritance/tombstone; restore creates a new revision. Mutations are idempotent by mutation ID and cannot leave dangling active pointers.

Cross-device branching preserves both revisions and exposes a conflict; it does not activate an arbitrary last-write-wins body. Tombstones fence stale resurrection. Retain active/draft/conflict baselines and the latest 50 inactive revisions per binding, with run/eval references protected before pruning; account deletion removes account-owned content. Prompt text is confidential configuration; Dexie reuse does not imply local at-rest encryption.

Register new tables with data governance, backup/deletion, CLI persistence and explicit companion/account-sync policies. Add schema only for this cohort; file editing does not need generic revision tables. Apply the migration claim procedure at implementation time.

## 6. Resolve applicability and composition before negotiating activation

### 6.1 Scope selects a version of one eligible slot

Process an operation in this order:

1. Bind the authoritative host, account, execution workspace and session/agent context.
2. Validate runtime/tool capabilities and host-assigned source trust. Editable content cannot grant either.
3. Discover applicable resources through their existing file, trigger and delivery owners.
4. Select custom versions only within supported slots/targets.
5. Compose using the declared operation and existing builder order; add host-owned framing separately.
6. Freeze the selected revisions for the operation and negotiate activation.
7. Translate through the actual runtime/provider adapter, apply the existing outbound gate, and record request-surface identity at that boundary.

For a code-only slot supporting all four scopes, specificity is eligible session > eligible agent > eligible workspace > account default > shipped default. Unsupported scopes never participate. This is not a global rank for rules, Skills, task text or permissions. Rule discovery retains its own layered/nearest semantics; Skills retain activation policy; source trust is not computed from proximity.

Legacy explicit session/member/character values preserve current nullish precedence until an explicit conversion. A generic built-in customization does not silently overwrite an explicit custom owner field. An explicit empty body, absent value and reset/inherit are separate operations. For a declared append slot, select one winning custom addition rather than accidentally accumulating every ancestor's addition.

### 6.2 Composition preserves baselines, input boundaries and provider shape

`append-rules` adds applicable guidance; `add-role` augments a known supported baseline; `activate-procedure` preserves on-demand Skill loading; `replace-template` replaces only a declared feature slot; `replace-baseline` is an explicit advanced profile. The runtime adapter declares which operations it can represent and reports unsupported combinations without substitution.

Builders retain dynamic branching, clipping, wrappers, output validators and live data selection. Editable templates allow typed placeholders and literal text only: no code execution, recursive evaluation, arbitrary object traversal, filesystem includes or remote fetch. Unknown variables, invalid types and contract mismatch block activation. Runtime variables stay unresolved in editor source; retrieved/task data never asserts source authority or host-frame state.

Preserve same-runtime/context output bytes, roles, ordering, cache annotations, delimiters and empty behavior with customization disabled, except separately documented P0 fixes. Behavioral equivalence across different runtimes/models is tested separately; identical bytes are not required across unrelated harnesses. Existing SDK preset/custom folding and prompt partitioning remain owning adapters.

### 6.3 Published configuration and active state have explicit transitions

| Negotiated mode        | Required activation behavior                                                                         | UI evidence                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `next-operation`       | New operations resolve the published revision; an in-flight request/retry keeps its frozen selection | Published and next/active revision plus adoption receipt at operation start |
| `reload-required`      | Save/publish remains pending until the owning loader successfully reloads                            | Reload action, failure state and active loader version                      |
| `new-session-required` | Existing session retains its prompt; use the existing recreate/fork lifecycle to apply changes       | Affected session, pending revision and explicit new-session action          |
| `checkpoint-adoption`  | A long-lived workflow/team run adopts only at an owner-defined safe checkpoint                       | Checkpoint policy, pending revision and adoption event                      |
| `unsupported`          | Draft/inspect/export can remain available; no activation claim                                       | Exact missing host/runtime capability or contract version                   |

These are proposed capability values, not claims that every current backend already implements them. Default new starts use current published policy unless explicitly pinned. Queue entries resolve at execution start; running operations never switch prompt revisions during retry. Fork semantics distinguish a new live-policy session from an explicitly pinned replay. Replays require recorded profile bodies/references and report unavailable material instead of substituting current defaults.

A protocol caching initial instructions must use its existing session recreation/context-version contract. Publishing, persistence success and remote adoption are separate receipts. Disconnect/cancel cannot turn a pending draft or reload into an activated revision.

### 6.4 Integrate at each existing consumer, without a second chat assembler

| Boundary                    | Required integration                                                                             | Owning verification                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| GUI chat                    | Existing `resolveSendOptions`, special workflow/aside/support paths and owner-selected resources | Default compatibility, operation-specific edits, special-session final surfaces  |
| Utility call                | Resolve through the title/summary/Canvas/etc. owner with explicit context                        | Edit reaches a real session-less utility request independently of chat           |
| Independent package         | Optional pure resolved-prompt provider and built-in fallback                                     | No root-app imports; package typecheck/build/pack and caller compatibility       |
| CLI/TUI local               | Selected local store/profile and existing config precedence before CLI default generation        | Restart persistence, read-only lock handling and baseline/additive compatibility |
| Connected CLI/paired mobile | Versioned authenticated capability on the selected host-management transport                     | Account/runtime-target validation, settled write/adoption receipts and reconnect |
| Sidecar/external agent      | Receive resolved compatible segments and revisions; preserve transport shapes                    | No duplicate append, final adapter digest, negotiated reload/session recreation  |
| Headless/remote worker      | Execution host binds account/profile before dispatch                                             | Store restore, host skew and isolation; no fallback to another local account     |
| First-party plugin          | Declare entries and consume resolved selections at real call boundaries                          | Activation/deactivation, unavailable plugin and optional SDK version behavior    |
| Rust bootstrap              | Owning launcher passes a supported override or generated portable default                        | Rust/launcher contract tests; no runtime TypeScript loading in web consumers     |

GUI and standalone CLI do not silently rewrite each other's stores. Connected clients share selected host authority; independent installations use validated explicit profile import/export. Automatic account sync remains an optional separately implemented policy. The existing [host-state client](../../cli/src/handoff/host-state-client.ts) is an extension seam, not proof an API already exists. Static-export UI uses supported native/remote transports and introduces no Next.js server dependency.

## 7. Preserve user work through upgrades, conflicts and recovery

| Condition                                              | Required result                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled body changes without customization             | New eligible starts use the updated default; running sessions follow their negotiated activation mode.                                                                                      |
| Compatible user customization and updated default      | Keep custom content; compare old baseline/custom/new baseline. Seeders never overwrite generic revisions or custom owner data.                                                              |
| Incompatible input/output/runtime contract             | Preserve the revision and mark activation incompatible; running compatible operations finish frozen. New starts follow the descriptor's explicit fallback/block policy with visible status. |
| External file edit or stale source save                | Reject stale expected content; keep the user's draft and show a source diff. Reload is separate from file persistence.                                                                      |
| Concurrent publish/reset                               | Reject stale concurrency revision, preserve branches, and offer merge/reload. Tombstones prevent stale activation resurrection.                                                             |
| Partial file/bundle write or DB failure                | Use owning atomic/transactional facilities; keep the prior valid source/binding or expose an explicit recovery failure. Never report success before the owner settles.                      |
| Missing/corrupt active revision                        | Detect before dispatch and apply the owning feature's declared error policy; do not substitute empty instructions.                                                                          |
| Removed/disabled plugin or unknown entry               | Mark unavailable/orphaned, preserve exportable custom work; never rebind by matching display name or body.                                                                                  |
| Locked account, host disconnect or read-only CLI store | Retain a scoped unactivated draft when supported and show the cause; never change authority to another account/local store.                                                                 |
| Old client/host cannot parse contract                  | Capability-gated refusal with upgrade-required status; preserve unknown imported data without activation.                                                                                   |
| Reset/restore                                          | Preview scope/source and inherited result; write a new version or checked source change, retain recovery history and leave unrelated edits intact.                                          |

Feature error policies retain meaningful differences: title generation can preserve its placeholder, permission judgment uses a conservative fallback, and required ledgered routing cannot silently switch profile. A failed model call does not automatically retry under a different prompt. Cancellation stops preview/reload subscriptions and never publishes a partial draft.

Backfill registers shipped identities first and leaves existing IDs, source files, preset defaults, user variants and session text intact. No bulk promotion of arbitrary conversation text into account defaults. Explicit conversions preview mappings and cannot infer resource identity from equal prose. Existing source seeders continue to own built-ins.

Rollback disables affected activation/consumer capabilities and preserves files, revisions and export recovery. Do not downgrade/delete an account DB to run an older binary. Additive schema changes still require version-aware CLI snapshot/backup recovery; test that older readers refuse safely. File-backed rollback uses expected-content writes and must not overwrite later external work. A data/schema rollback and a prompt activation rollback are distinct operations.

## 8. Keep privacy, permissions and advanced activation under their existing owners

The management read model and deterministic preview make no model/network call. Keep live rendered context in memory with redaction by default; do not persist retrieved knowledge, profile entities, secrets or current task text into static revision history. Do not expose credentials/environment secrets as template variables. A file or user-authored static body can itself contain private information, so exports use the existing scan/selection controls.

The existing outbound PII gate must inspect the effective custom text and interpolated data at the owning call boundary, after relevant provider translation. Prior validation of a bundled template is not clearance for later overrides. Preserve [external prompt gating](../../lib/ai/agent/external/policy/outbound-prompt-pii.ts), the [shared runtime gate](../../packages/agent-runtime-kit/src/prompt-gate.ts) and each utility/plugin/package gate, including encoded text. No route can send a locally derived custom body solely because it was registered.

Executable host policy owns filesystem/network/process access, approvals, tools and budgets. Source/authority classification is host-assigned; plugin/import metadata cannot mint stronger placement or grants. Host frame state is structured provenance, not an editable substring. Conflict warnings are advisory: their absence cannot prove that model instructions are consistent.

Advanced profiles retain edit, test, history and compatible activation as part of final delivery:

| Cohort                                    | Activation contract                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full runtime baseline                     | Explicit replace action; baseline visibility/compatibility report; preserve tool/permission enforcement and label opaque upstream content.                     |
| Router Fusion roles                       | Custom profile/version participates in new action/run/quality/replay identity; shipped `roles-1` checksums stay unchanged.                                     |
| Compaction/goal/loop/team protocol        | Preserve required output schema/trailers, continuation/recovery and retained task constraints; validate behavior-specific fixtures and run checkpoints.        |
| Command judge / approval-sensitive helper | Explicit host-owned approval-policy review; adversarial regression evaluation and conservative fallback. Custom model verdicts alone must not widen authority. |

Deterministic fixtures cannot certify model safety or quality. Implement the policy under which approval-sensitive custom profiles can activate before exposing that capability; precise unavailable status is required during staging and is not final cohort completion. Imported code or prompt prose cannot reconfigure host enforcement.

## 9. Separate selection identity, final request evidence and context budgets

### 9.1 Correct the two known mechanisms before relying on an inspector

Source patterns were rechecked for this revision; the [comparison report](../research/2026-10-20-agent-prompt-management-comparison.md) records the helper-level demonstrations and their limits.

| Issue                                                             | Owning change required in P0                                                                                                                               | Regression evidence                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: composition hashing uses `systemPrompt ?? appendSystemPrompt` | Include all selected semantic segments; distinguish that selection digest from the final adapter surface after SDK overlays and special-session transforms | Append-only changes, SDK overlay changes and late special-session replacement affect their relevant identity. No claim every existing trace was wrong.                      |
| F2: `<subagent_contract>` substring suppresses framing            | Separate editable identity from host frame; use host-owned structure for trusted idempotence                                                               | Literal tag examples cannot suppress env/contract; empty identities and trusted nested frames work without duplication. This is not a demonstrated tool-permission exploit. |

These are future implementation changes, not fixes performed by this proposal update.

### 9.2 Record bounded provenance without raw prompt logs

Use separate versioned values:

- Selection/profile identity: chosen resource IDs, owner revisions/content digests, operations, applicable target, contract/runtime compatibility and relevant policy versions.
- Final request-surface identity: exact visible instructions/roles/segments/cache options after owning adapter transforms, with a defined canonicalization and observation boundary.
- Active-state evidence: selected/published/active revision, frozen operation or remote session, pending activation and adoption receipt.

An early assembly digest is not proof of a complete upstream prompt. Unknown provider instructions remain unknown. Extend existing [composition digests](../../lib/agent/composition/digest.ts) and [model-request events](../../lib/ai/replay/model-request-shadow.ts) without adding raw prompt text to their digest/reference-only shape; descriptor metadata can use a separate typed optional event. Full recording uses existing encrypted eval assets and retention.

Version affected result caches by effective prompt/profile, model and relevant policy contract in addition to their existing input/context keys. In particular, editable command-judge activation must not reuse verdicts produced under a different prompt/policy. This is an integration requirement; the current constant-prompt cache is not asserted to be defective.

Proposed local signals are `prompt_resolution_failed`, `prompt_contract_incompatible`, `prompt_publish_conflict`, `prompt_authority_unavailable`, `prompt_activation_pending` and `prompt_override_applied`. Metric labels are bounded family/runtime/failure enums; user text, names and session IDs are not metric dimensions. Show actionable failures in the editor/owning feature, not only logs.

### 9.3 Reuse model-context delivery separately from UI lazy loading

[Skill delivery](../../lib/skills/delivery.ts) and [budget/degradation](../../lib/skills/prompt-budget.ts) already exist. Keep them authoritative. Registering an entry never injects the catalog or its full body into every model call.

| Budget class                           | Required behavior                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Required operational/protocol segments | Preserve required contracts as complete segments; if they cannot fit, report an unsupported/error state rather than silently truncating.  |
| Discovery metadata                     | Apply the existing shortening/omission policy and show discoverable versus omitted resources with reasons.                                |
| On-demand procedures                   | Load eligible Skill bodies/resources through their existing invocation path; body changes cannot bypass delivery/capability controls.     |
| Static optional instructions           | Measure total size, expose redundant/conflicting guidance as advisory, and keep explicit inclusion/omission decisions.                    |
| Dynamic runtime data                   | Keep existing feature clipping, retrieval selection and stable/dynamic cache boundaries; never copy the live result into template source. |

Proposed performance requirements: metadata-first listing; lazy bodies; no runtime filesystem/network fetch for bundled defaults; one selection snapshot read per owner operation rather than a DB query per interpolation; no catalog-wide import on chat hot paths. Measure bundle bytes, cold UI load, resolve time, first-call latency and token deltas per runtime before claiming an improvement or setting numeric latency targets. Model-family compatibility needs separate evaluation, not forced byte equality across models.

## 10. Ship independently verifiable cohorts, starting with provenance correctness

| Phase                                                  | Single owner role         | Dependencies / deliverable                                                                                                                                                                                           | Completion and abort condition                                                                                                                                                                   | Rollback                                                                                                               |
| ------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| P0: inventory, contracts and correctness prerequisites | Prompt architecture owner | Classify each cohort's sources/consumers, target locations and operations; implement F1/F2 with co-located regressions before inspector claims                                                                       | Default compatibility plus append/overlay/special-session identity and frame-idempotence tests pass; any unresolved omitted segment/trust-forging mechanism blocks affected inspector activation | Disable affected inspector claims/consumer rollout; do not restore a known defect as a required compatibility behavior |
| P1: complete first management cohort                   | Prompt product owner      | P0; migrate the selected owner's sources/tests/imports; file-backed instructions/Skills, role/preset/domain adapters, shared UI flows, one ordinary utility template; minimal generic storage only for that template | Edit → source save or publish → negotiated activation → actual call → restart/restore/reset works; file conflict/account isolation and active-state UI pass                                      | Disable new activation/writes; preserve source data, revisions and export recovery                                     |
| P2: ordinary feature-template coverage                 | Feature prompt owner      | P1 shared UI contract; title/summary/Canvas/completion/twin/Radar/wiki/etc. owners and remaining ordinary package/plugin calls                                                                                       | Every declared template has a reachable consumer, output/fallback fixtures, budget and cache-version behavior; saved-but-unused overrides block the cohort                                       | Disable individual adapters, preserve custom work as unavailable and retain prior compatible defaults                  |
| P3: host/runtime coverage                              | Host integration owner    | P0/P1; can progress alongside P2; standalone CLI, connected clients, mobile, remote/headless, sidecar and required Rust launch boundaries                                                                            | Auth/account/host validation, version skew, persistence, lock/reconnect and per-runtime activation evidence pass; no silent local/remote authority fallback                                      | Disable unsupported capabilities without rewriting another host/store; keep drafts/import/export                       |
| P4: advanced compatible profiles                       | Agent policy owner        | P0/P1 plus each affected consumer; can progress independently of unrelated P2/P3 adapters                                                                                                                            | Routing identity, baseline replacement, compaction/continuation and approval-sensitive policy/evaluation gates pass; incompatible output or policy widening blocks activation                    | Disable advanced profile adoption at new-operation/checkpoint boundaries; never mutate an active frozen run            |
| P5: closure, documentation and compatibility cleanup   | Prompt architecture owner | All agreed first-party cohorts and host matrix; remove only migrated compatibility paths                                                                                                                             | Full promised edit/override scope is working, no dormant publish controls, evidence and bilingual docs complete                                                                                  | Preserve recovery exports and supported prior-build/data recovery instructions                                         |

P1 is a useful release cohort, not completion of the accepted full scope. All declared first-party categories require supported owner/profile editing and activation by closure; external opaque prompts and executable contracts remain explicit non-goals. Optional automatic sync and general third-party SDK extensions must not block otherwise complete local/host cohorts.

Each phase includes owning tests, docs, privacy checks, migration/rollback work and runtime reachability evidence. No new package, DB migration, native command or host channel is created without its actual consumer; each new boundary requires version/ACL/capability review. No schema version is allocated in this design.

Expansion gates: zero unapproved default-output mismatches for the same runtime/context; zero cross-account/host applications; zero dangling active revisions; zero PII/permission boundary regressions; no misreported active state. Stop the affected cohort on any such failure. These gates do not substitute for model-quality evaluation.

## 11. Acceptance proves resource semantics and actual activation

| Acceptance                 | Goal / behavior contract                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Default migration       | G3/G5: same-runtime/context output bytes, roles, delimiters, empty handling, cache options and fallbacks match existing fixtures except explicit P0 fix expectations.                                      |
| A2 Resource operations     | G1/G3: rule append, additive role, legacy replacement, Skill activation, feature replacement and advanced baseline replacement each retain their documented boundaries.                                    |
| A3 Canonical sources       | G2: project-file save uses expected content and is visible in Git; domain screens and Prompt Center show one owner value; generated files remain immutable.                                                |
| A4 Scope and authority     | G2/G3/G6: eligible slot specificity works without granting permissions, reclassifying task data or targeting the visible rather than execution workspace.                                                  |
| A5 Real utility consumer   | G1/G3: a published ordinary template changes the next eligible title/summary request without a normal chat send.                                                                                           |
| A6 Published versus active | G1/G3/G4: each activation mode reports pending/active truthfully; failed reload/reconnect does not claim adoption; cached remote sessions use their lifecycle contract.                                    |
| A7 Frozen operation        | G3/G4: publish during streaming, retry or team step leaves the frozen revision unchanged until its owner-defined adoption point.                                                                           |
| A8 Correct provenance      | G4: append-only edits, SDK overlays and late special-session replacement change relevant identities; selection identity and final request identity are labeled separately.                                 |
| A9 Trusted framing         | G3/G4: literal user tag text cannot skip host env/contract; nested trusted framing stays idempotent without content-based provenance.                                                                      |
| A10 Budgets and delivery   | G5: growing catalog metadata does not load all bodies; omission reasons are visible; required contracts remain whole; dynamic data stays outside revision history.                                         |
| A11 Upgrades/conflicts     | G1/G2: base/contract upgrade, stale file writes, competing publish/reset and missing resources preserve drafts/history and cannot silently activate incompatible content.                                  |
| A12 Host parity            | G6: GUI, standalone/attached CLI, headless, supported mobile and remote execution use their selected authority and declared runtime semantics, not identical hidden harness text.                          |
| A13 Advanced behavior      | G3/G5: routing changes get new action/profile/replay identity; compaction retains goals/constraints; judge overrides follow explicit host policy and cannot reuse old-policy cache results.                |
| A14 Privacy                | G2/G5: effective custom/interpolated content reaches the owning outbound gate; preview/telemetry/history do not persist live secrets or retrieval context.                                                 |
| A15 Recovery               | G1/G2/G6: crash, read-only CLI lock, host loss, account switch, plugin removal and backup restore leave valid prior state or explicit unavailability.                                                      |
| A16 Reachability           | G1/G3: every active descriptor has a real consumer and an owning integration test; editing an unused registry entry cannot pass delivery acceptance.                                                       |
| A17 Source relocation      | G2/G3: moved definitions retain IDs, output bytes/shapes, co-located tests and public export compatibility; generated catalogs and packed consumers resolve the new owner without duplicate source bodies. |

Implementation uses focused co-located Jest/Rust tests, affected generator `--check`, package build/typecheck/pack, current root `pnpm typecheck`, focused ESLint, `pnpm lint:static-export` and `pnpm build` where applicable. UI changes require real browser/Tauri acceptance for the implemented surface and both split locale trees followed by `pnpm i18n:build`, `pnpm i18n:build:check` and `pnpm lint:i18n`. CLI/file/remote claims require their owning harness. Coverage is opt-in only.

Before enabling an editable cohort, maintain separate deterministic contract/wiring fixtures and model behavior evaluations with fixed model/runtime/tool/input sets. Compare baseline/additive/replacement configurations on task completion, instruction adherence, tool/protocol validity, cost and relevant unsafe/ambiguous cases. Record failures and uncertainty; no unmeasured quality improvement or safety guarantee is inferred from schema validity.

This task updates the proposal only. Earlier helper demonstrations are evidence of F1/F2, not full send-path tests. Document formatting/link/consistency checks do not establish application build, UI, provider, model-quality or end-to-end acceptance.

## 12. Review decisions and accountable follow-up

| Decision                         | Recommended resolution                                                                                                                                               | Alternatives / consequence                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Q1 Management depth              | **Decided by user:** complete editing/override UI with source ownership and compatible activation; do not ask to reconfirm it                                        | Index-only is an intermediate state, not final completion                                     |
| Q2 Canonical content             | File-backed resources remain files; domain resources retain owners; generic revisions only for code-only slots                                                       | Mirroring all bodies in one DB creates conflicting authority and weakens repository workflows |
| Q3 Composition and compatibility | Typed resource operations, authority eligibility and runtime/model/tool contracts; legacy behavior changes only through explicit conversion                          | A universal final-string replacement can remove unrelated operational context                 |
| Q4 Delivery order                | P0 correctness → P1 instructions/roles/Skills and one utility → independently verified ordinary-template, host and advanced cohorts                                  | All-at-once infrastructure postpones usable owner flows and increases default-output risk     |
| Q5 Propagation                   | Selected host authority for connected clients; explicit import/export for independent stores; optional E2E account sync needs its own policies/conflicts             | Identical code is not shared persistence; automatic everywhere requires additional contracts  |
| Q6 Advanced activation           | Explicit replace/profile semantics and cohort-specific behavior/policy gates before activation                                                                       | A generic JSON/placeholder check cannot certify approval or protocol compatibility            |
| Q7 Directory/package boundaries  | One `lib/prompts/` management entry, domain-owned bodies and targeted relocations in sections 3.3–3.4; extract a package only for demonstrated independent consumers | A global body dump mixes ownership; a mandatory new package adds coupling                     |

Q2–Q7 are engineering recommendations for review, not recorded human approvals or permission questions blocking this documentation update. Detailed model-quality targets and approval-sensitive activation rules must be accepted by their owning reviewers before that implementation cohort ships.

The following **2026-10-23** dates are proposed review deadlines retained from the initial plan, not delivery promises or accepted assignments.

| Follow-up                                                                | Single owner role         | Proposed ISO DDL | Completion evidence                                                             |
| ------------------------------------------------------------------------ | ------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| Record resource/owner/operation matrix and P0 regression plan            | Prompt architecture owner | 2026-10-23       | Q2–Q4/Q7 resolution; every cohort has real consumers and independent acceptance |
| Confirm file-write, data-governance, backup and host authority contracts | Account/host data owner   | 2026-10-23       | Q5 and source persistence/deletion/conflict matrix                              |
| Define advanced activation and behavior evaluation bar                   | Agent policy owner        | 2026-10-23       | Q6, cache-version rules and conservative failure policy                         |
| Review full editor and pending/active interaction flows                  | Prompt product owner      | 2026-10-23       | Edit/save/publish/reload/diff/history/reset and inaccessible/offline states     |

| Review record                         | Status                     | Evidence                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source inventory                      | Rechecked, read-only       | Stable HEAD; catalog counts and both identified source patterns rechecked during consolidation; broad 158-file scan remains a historical heuristic worklist                                               |
| Product requirement                   | Confirmed                  | Full management UI with edit/override retained                                                                                                                                                            |
| Comparison findings                   | Integrated into the design | Resource contracts, file owners, activation matrix, P0 prerequisites, budgets/evals and independently verified cohorts replace the earlier amendment overlay                                              |
| Document validation                   | Completed                  | Prettier and all 94 local links checked; target layout/migration mapping, proposed-path labels, 17 acceptance cases, ID/export preservation, phase consistency and whitespace/conflict markers validated. |
| Human architecture/data/policy review | Pending                    | Q2–Q7 are proposed; no approval inferred                                                                                                                                                                  |
| Implementation/runtime acceptance     | Not run in this update     | No application source, runtime prompt, schema, dependency, commit or external publication changed                                                                                                         |

## 13. Repository evidence and related decisions

The inventory links and the [comparison report](../research/2026-10-20-agent-prompt-management-comparison.md) are the evidence for this consolidated design. Competitor facts and primary URLs remain in the [source extraction](../research/2026-10-20-agent-prompt-management-comparison-sources.md); they inform recommendations without asserting universal product behavior. The following repository decisions constrain integration:

- [ADR-0030: character pack ownership and updates](../content/docs/en/adr/0030-character-pack-overlay-capability.md): retain domain ownership, overlay/clone identity and selective updates.
- [ADR-0047: project instruction files](../content/docs/en/adr/0047-project-instruction-files.md): retain layered discovery, native readers and precedence.
- [ADR-0117: composed agent modes](../content/docs/en/adr/0117-composed-agent-modes-and-creator.md): preserve versioned composition and digests rather than conflating prompt identity with runtime choice.
- [ADR-0161: agent identity, runtime and host](../content/docs/en/adr/0161-agent-identity-runtime-and-host.md): reuse the canonical subagent identities and preserve host/runtime separation.
- [ADR-0188: routed-turn ledger](../content/docs/en/adr/0188-a-routed-turn-spends-only-what-its-ledger-reserved.md): custom prompts must not share incompatible action/quality identity or silently alter a ledgered run.
- [Built-in Skill generation](../../scripts/build/build-builtin-skills.mjs), [prompt partitioning](../../lib/ai/prompt-partition.ts), [sidecar prompt folding](../../sidecar/src/runtimes/claude-agent-sdk/system-prompt.ts): existing build and transport mechanisms to extend.
- [Data table catalog](../../lib/data-governance/table-catalog.ts), [account sync table policies](../../lib/account-sync/data/tables.ts), [CLI store bootstrap](../../cli/src/db/bootstrap.ts): new tables require explicit persistence, authority, sync, backup, deletion and older-version behavior.
- [Checked workspace filesystem operations](../../lib/files/workspace-fs.ts), [Skill delivery](../../lib/skills/delivery.ts) and [Skill budgets](../../lib/skills/prompt-budget.ts): reuse existing source writes and on-demand loading controls.
- [Encrypted eval assets](../../lib/ai/eval/assets.ts), [model-request shadow events](../../lib/ai/replay/model-request-shadow.ts): reuse authorized recording and digest-only observability; no raw prompt logging by default.

This document adds no application behavior, dependency, route, database migration, prompt wording, commit or external publication.
