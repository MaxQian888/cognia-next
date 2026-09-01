---
title: "0161: An agent, its runtime, and its host are three questions"
description: "The first-party runtime becomes an ordinary entry in one catalog, the turn's runtime becomes one AgentRuntimeRef owned by the session, and built-in agent definitions get a single shared catalog instead of one per shell."
---

# ADR 0161: An agent, its runtime, and its host are three questions

**Status:** Accepted
**Date:** 2026-09-01
**Related:** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility), [ADR-0117](./0117-composed-agent-modes-and-creator), [ADR-0142](./0142-agent-sdk-two-layer-product), [ADR-0077](./0077-tui-external-agent-hosting)

## Context

The product called one lane 内置 agent (the built-in agent) and everything else
external. Neither word described what actually distinguished them.

**The built-in lane was a hosting mechanism, not an agent.** `AgentRuntime` was
`"claude-sdk" | "external"`, and `claude-sdk` did not mean the Claude Agent SDK.
It meant "whatever the bundled Node sidecar decides to run", and the sidecar
runs two runtimes (`sidecar/dispatch/runtime-adapter.mjs`): `claude-agent-sdk`
for Anthropic and `ai-sdk` for every other provider. Which one serves a turn is
derived from the provider by `runtimeFromLegacy`
(`lib/ai/agent/execution/legacy-mapping.ts`), never from the chip. So a DeepSeek
session read "Built-in Anthropic SDK sidecar" in the runtime menu, in the
tooltip, and in the accessible name, and because that chip is glyph-only on the
built-in lane, the wrong wording was the only wording a screen reader received.

Meanwhile Claude Code, the same vendor running the same models, was one of 18
entries under external presets. The real distinction was "spawned by our
sidecar" versus "spawned by something else", wearing a label that promised
first-party versus third-party.

**The built-in lane was the only lane that was not a registry entry.** External
protocols, external presets, subagents, MCP presets, hooks, teams and characters
are all catalogs with plugin overlays. The built-in runtime was a string literal
in a closed union, hardcoded in the store, the composer chip, the toolbar and
the send path, so it alone could not be enumerated, described, capability-queried
or health-reported.

**Three fields answered one question.** `runtime`, `externalAgentId` and
`externalHostConfig` were persisted separately and could describe a lane with no
target. That state could not send a turn, and roughly 40 lines of repair effects
in the composer chip existed only to reconcile the three, including a regression
where the repair rewrote a user's plugin-backed agent to the default on every
restart.

**The lane was global while the composition was per-session.** ADR-0117 moved
`modeId` onto the session precisely because a single global value retargeted
every other session, including one mid-turn. `runtime` was left global and read
at send time, which is the same defect on the larger axis.

**Built-in agent definitions exist twice.** The app ships four `workflow-*`
subagents plus `Explore` and `Plan`. The CLI ships `general-purpose`, `Explore`
and `Plan`. The two `Explore` and `Plan` definitions have different prompts and
different tool derivations, the app has no `general-purpose` at all, and the two
shells disagree about collisions: the CLI lets a discovered agent override a
built-in, while the app namespaces user templates under `template:` so they
cannot.

## Decision

### 1. Three axes, named separately

| axis | question | owner |
| --- | --- | --- |
| Identity | who this agent is (name, prompt, tools, model role) | the built-in catalog, plugin subagents, user templates, all projected to one wire `AgentDefinition` |
| Runtime | what executes it (process plus protocol) | `AgentRuntimeRef` |
| Placement | which machine it runs on | the existing `executionTarget` and `SessionExecutionBinding`, unchanged |

`TeammateExecutionBinding` already separated runtime from placement one level
down. The main chat session never got the same treatment, and this is it.

### 2. The first-party runtime is an ordinary catalog entry

`lib/ai/agent/runtime-catalog` lists every runtime as an `AgentRuntimeDescriptor`:
the built-in lane, each locally configured external agent, and each
configuration the paired host owns. The rule to hold onto is that the
first-party runtime must be describable by the same record a third-party one
uses. If `claude-agent-sdk` cannot sit in the catalog next to `codex`, the
catalog is wrong.

The catalog is pure. Every input is passed in, so it carries no shell probe and
runs in the fast test project. The React plumbing lives in
`hooks/agent/use-agent-runtime-catalog.ts` and does nothing but gather inputs.

### 3. The built-in row names its derived engine

A descriptor carries `derivedAdapter`, resolved through the same
`runtimeFromLegacy` the frozen execution spec uses, so the label cannot drift
from what dispatch does. The row reads "Anthropic Agent SDK, in the bundled
sidecar" only when that is true, and "AI SDK, running {provider}" otherwise.

The built-in lane stays one selectable choice rather than two, because the
adapter is derived rather than chosen. `AgentRuntimeRef` still carries an
optional `adapter` pin, mirroring `TeammateExecutionBinding.runtimePolicy`, and
that pin ships deliberately inert: documented at the type, unreachable from any
surface, and pinned by a test. Honouring it later is a resolver change, not a
type change.

### 4. One ref, owned by the session

`AgentRuntimeRef` is `builtin`, `external:<agentId>`, or `host:<configId>` with
its admission stamp. One value makes "a lane with no target" unrepresentable.
Persist v2 to v3 folds the three legacy fields, prefers a host stamp when a
half-applied write left both set, and drops v2's dead state to the default lane
rather than carrying it forward. The flat fields survive as deprecated mirrors,
written only by `setRuntimeRef`, so an unmigrated reader still sees the truth
and a downgrade still opens on the right lane.

The ref moves onto `AgentCompositionSelectionV1` as the real meaning of
`runtimeBindingRef`, with the store holding only the default for new sessions.
That field currently carries an external agent's native session id for imported
sessions, which is a third unrelated meaning and gets its own name.

### 5. One built-in agent catalog, two tool vocabularies

App and CLI read the same `BuiltinAgentEntry` list, tagged by surface. Tool
policy is declared abstractly (`inherit`, `read-only`, an explicit allowlist)
and resolved by each shell against its own vocabulary, so one catalog serves two
tool surfaces without pretending they are the same list.

`general-purpose` joins the catalog for the CLI and team surfaces. It stays out
of plain chat in this change: the app already surfaces at least six dispatchable
subagents, so `dispatch_agent` is never withheld there, and adding a
general-purpose delegate to every chat turn is a behaviour change that deserves
its own decision.

### 6. Precedence: built-ins are replaceable, plugins stay namespaced

Built-in ids are bare. Plugin ids stay `<pluginId>:<id>`, because namespace
isolation is a security property. A user or project template may claim a bare id
and shadow a built-in, which is the CLI's existing rule extended to the app and
matches how comparable agent systems resolve `project > user > builtin`.

### 7. "Built-in" describes definitions, never a runtime lane

The word now means "an agent definition shipped with the app, which you can
replace". It is not a name for a hosting mechanism. User-facing copy for the
runtime lane names Cognia's own runtime and the engine serving the turn.

### 8. External turns ride the frozen execution spec

`LegacyExecutionSignals.runtime` already exists and `runtimeFromLegacy` already
answers `"external"`. Chat simply never passed it, so external turns bypassed
ADR-0090 entirely: no capability gate, no execution fingerprint, no unified cost
or trace accounting. Chat feeds the resolved ref into
`resolveAgentExecutionSpec`. `ExternalAgentManager` stays the executor for
`runtimeAdapter === "external"`, with the spec as its contract rather than
something it bypasses.

## Consequences

- The composer chip stops asserting an engine it is not running, including in
  the accessible name, which was its only wording on the default lane.
- A runtime can be described, blocked, warned about and health-reported through
  one record, so a new lane is a catalog entry rather than a fourth branch in
  four files.
- The dead "external with nothing selected" state is unrepresentable, and the
  repair effects that existed to detect it are gone.
- Switching runtime in one conversation stops retargeting the others.
- `Explore` and `Plan` stop being two different agents wearing one name.
- Cost, tracing and capability gating cover external turns, which previously
  reported nothing.

## Alternatives considered

**Rename the label and stop.** It fixes the sentence and none of the structure.
The lane would still be unenumerable, the three fields would still disagree, and
the next runtime would still be a fourth branch.

**Make the built-in adapter a user choice (two rows).** It would invent a
control the resolver does not honour. The adapter is derived from the provider,
and offering a pin that dispatch ignores is exactly the dormancy this repo keeps
hitting. The pin exists in the type, inert and labelled, until a resolver
honours it.

**Collapse all five agent-definition shapes into one.** The catalog shape, the
authoring shape and the wire shape have genuinely different jobs, and the SDK's
`AgentDefinitionV1` is a separate product surface under ADR-0142. What is wrong
is unnamed projections that silently drop fields, not the existence of more than
one shape.
