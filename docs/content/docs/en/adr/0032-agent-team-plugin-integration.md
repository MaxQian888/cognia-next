---
title: ADR-0032 — Agent Team Plugin Integration
---

# ADR-0032 — Agent Team Plugin Integration

> Status: **Accepted** · 2026-05-23

## Context

The Agent Team subsystem (ADR-0022) shipped as a self-contained orchestration
engine: data model, Zustand store, F-path workflow synthesizer, `BudgetGuard`,
`TeammatePool`, `TeamNotifier`, plus a comprehensive workspace UI.

Independently, the plugin system grew an `OVERLAY_REGISTRY_CAPABILITIES`
dispatch loop (PR-D) that codifies five uniform-shaped capabilities — `skills`,
`mcpServerPresets`, `nativeAnthropicTools`, `externalAgentPresets`, and ADR-0030
`characterPacks` — each registered into a `createOverlayRegistry` overlay on
plugin enable.

The two subsystems never met. Agent teams couldn't consume any plugin
capability: `AgentTeamConfig` had no `capabilities` field, teammates couldn't
opt into a plugin skill, and the only subagents available to a team were the
four host-bundled workflow-\* ones — hardcoded into `lib/claude/agents/subagents`.
Plugins had no manifest field for "complete team blueprints" either.

This ADR records the integration approach that landed in the May 2026 work.

## Decision

Promote Agent Team to a **first-class plugin ecosystem consumer** through
seven coordinated mechanisms:

### 1. Two-layer capability scope

- `AgentTeamConfig.capabilities: TeamCapabilityBundle` — the team-level
  default pool every teammate inherits.
- `TeammateConfig.capabilities: TeammateCapabilityOverlay` — per-teammate
  overlay with `add` / `remove` / `replace` semantics per key.
- `lib/ai/agent/team/capability-resolver.ts:resolveTeammateCapabilities` is the
  single pure function that merges them into a `ResolvedCapabilities` snapshot
  consumed by the runtime.

### 2. Subagent plugin capability (overlay-registry #6)

Plugins declare subagents via `manifest.subagents: PluginSubagentDef[]`
(mirrors the Claude SDK `AgentDefinition` shape). They register through
`subagent-registry` (a one-liner `createOverlayRegistry` instance). Built-in
workflow-\* subagents stay alongside the overlay; runtime projection lives in
`lib/claude/agents/subagents/index.ts:resolveAllSubagents`. Plugin subagents
are namespaced as `<pluginId>:<id>` so dispatcher-name collisions are
impossible.

### 3. Agent-Team-Template plugin capability (overlay-registry #7)

Plugins declare complete team blueprints via
`manifest.agentTeamTemplates: PluginAgentTeamTemplateDef[]`. Each entry can
declare a `requires` block (cross-capability dependencies); the registry
stamps non-blocking warnings on register and refreshes them when sibling
registries mutate (mirroring the ADR-0030 character-pack pattern). The
settings UI surfaces warnings as disabled "Use" buttons + missing-deps
badges.

### 4. Full hook integration

`runTeamLifecycle` dispatches plugin hooks at the seven canonical points
(`onTeamStart` / `onTeamPlanReady` / `onTeamBudgetWarn` / `onTeamComplete`),
and the `action.team.task.dispatch` executor dispatches `onTeammateClaim` /
`onTeammateRelease` together with the existing `onAgentStart` /
`onAgentComplete` / `onAgentError` lifecycle.

`BudgetGuard`'s existing `on("warning_crossed")` / `on("critical_crossed")`
event emitters wire directly to `onTeamBudgetWarn` — no new emitter
infrastructure was added.

### 5. Consensus / SharedMemory / Delegation orchestrators

The store already carried `upsertConsensus` / `writeSharedMemory` /
`upsertDelegation` / `updateDelegationStatus` etc. The integration adds
three **thin** orchestrator modules over them:

- `consensus-orchestrator.ts` — `createConsensus` / `castVote` (auto-resolves
  on threshold) / `resolveConsensus` (lead override) / `cancelConsensus`.
  Pure helpers `tallyVotes` / `computeWinner` carry the math.
- `shared-memory-orchestrator.ts` — `publishEntry` (PII-gated through
  `lib/twin/ingest/redact.ts:hasNoLeakingPii`) / `deleteEntry` /
  `autoPublishTaskResult` / `clearTeamMemory`.
- `delegation-orchestrator.ts` — `delegateToBackground` (drives
  `background-agent-manager` + `executeAgent`) / `delegateToExternal` /
  `completeExternalDelegation` / `cancelDelegation`.

Each orchestrator fires the matching plugin hook (`onConsensus*` /
`onSharedMemory*` / `onTeamDelegation*`).

### 6. PresetEditor reuse for TeammateConfigDialog

The existing `<PresetEditor>` (`components/settings/presets/preset-editor.tsx`)
already edits identity / capability / tools / advanced sections with skill
and MCP catalogs injected. The integration:

- Adds two opt-in props — `extraSections` and `requireContent` — so callers
  can append additional sections + skip the system-prompt-required check.
- Adds four optional fields to `PresetEditorState` (`nativeAnthropicToolIds`,
  `characterPackId`, `externalAgentPresetId`, `subagentIds`).
- Ships five new editor sections (NativeTools / Subagent / Character /
  ExternalPreset / TeamCapabilityOverlay).
- `<TeammateConfigDialog>` wraps `<PresetEditor>` with the new extras + a
  roster section (runtime / specialization / temperature).

No proliferation of duplicate editors: `<PresetEditor>` is the single source
of editor truth for presets, custom modes (future), and teammates.

### 7. Workspace settings refactor

`workspace/settings.tsx` switched from a flat card stack to a four-accordion
composition: **Overview** (existing 3 cards), **Plugins & capabilities** (new),
**Governance** (TeamGovernancePolicy editor), **Memory** (SharedMemory KV view).
`activity.tsx` gained a ReportTimeline + ConsensusPanel.

## Persistence migration

`stores/agent/agent-team-store/store.ts` bumps `PERSIST_VERSION` 1 → 2. The
migration is pure (exported as `migrateAgentTeamPersisted`) and backfills
`governancePolicy` + `capabilities` defaults on the persisted `defaultConfig`
and every template's `config`. The migration is idempotent — applying it to
v2 input is a no-op.

## Hooks added to `CANONICAL_HOOK_POINTS`

`onTeamStart` · `onTeamPlanReady` · `onTeammateClaim` · `onTeammateRelease` ·
`onTeamBudgetWarn` · `onTeamComplete` · `onConsensusOpened` ·
`onConsensusVoted` · `onConsensusResolved` · `onSharedMemoryWrite` ·
`onSharedMemoryDelete` · `onTeamDelegationStart` · `onTeamDelegationComplete`

Each carries a typed payload (see `types/plugin/plugin.ts`).

## Consequences

- Plugins now extend Agent Team in the same uniform-shaped way they extend
  characters, skills, MCP servers, and native tools.
- Adding an eighth capability is one entry in
  `lib/plugin/contracts/capability-bridge-map.ts:OVERLAY_REGISTRY_CAPABILITIES`.
- TeammateConfig editing centralises on the preset editor, so future preset
  features automatically improve teammate editing.
- Plugin team templates with missing deps remain visible but inert — operators
  get a discoverability nudge instead of a silent failure.

## Reuse audit (artifacts kept from prior work)

- `createOverlayRegistry` factory — 4 existing registries plus 2 new (subagent
  - agent-team-template), each is a one-line instantiation.
- Store CRUD actions for consensus / shared memory / delegation / execution
  report already existed; orchestrators are thin business-logic wrappers.
- `BudgetGuard.on(...)` emitter API was unchanged — hook dispatch added as
  listeners.
- `<PresetEditor>` reused instead of building a new `AgentSubjectEditor`.
- `lib/twin/ingest/redact.ts:hasNoLeakingPii` reused as the SharedMemory PII
  gate (red-line per ADR-0003).

## See also

- ADR-0022 — Agent Team runtime hardening
- ADR-0030 — Character pack overlay capability (`requires` warning pattern
  mirrored here)
- ADR-0020 — Computer Use completeness (native-anthropic-tool capability)
- ADR-0017 — Workflow plugin extension points (workflow capability shape)
