---
title: "0198 — A run's capabilities are granted, not patched"
description: "Features that launch an agent (scheduler, workflow nodes, plugins, bots, subagent dispatch) used to adjust the run by editing the SendOptions the resolver had already returned. That skipped the tool filter, Restricted Mode, the parent ceiling and the finalizer, and let a scheduled task replace the agent's deny list. This ADR adds one versioned contract, AgentCapabilityGrantV1, that every such caller hands to resolveSendOptions instead, and applies each field at the stage of the profile field it extends."
---

# ADR 0198 — A run's capabilities are granted, not patched

**Status:** Accepted
**Date:** 2026-09-27
**Related:** [ADR-0117](./0117-composed-agent-modes-and-creator) (composition axes), [ADR-0161](./0161-agent-identity-runtime-and-host) (identity, runtime, placement), [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (the unified execution service), [ADR-0002](./0002-scheduler-full-agent-resolution) (scheduled runs resolve the full agent)

## Context

An agent profile (`Character`) says what an agent is. The features that launch
agents also need to say what one run may additionally use or must do without:
a scheduled task needs its report skill, a workflow step wants one MCP server
and a stricter permission mode, a plugin wants a prompt fragment.

None of them had an input for that. `resolveSendOptions` only read the
character, the session, the mode and a few surface-specific fields. So each
caller patched the result:

- The scheduler assigned `model`, `permissionMode`, `maxTurns` and `effort`,
  unioned `allowedTools`, **replaced** `disallowedTools`, swapped in an MCP map
  and spliced an ad-hoc skill into the system prompt, all after the resolver
  returned (`applyPayloadOverrides`, `applyAdHocSkill`).
- `executeAgent` unioned the run's deny list and appended system text after
  resolving, and ignored the caller's `model`, `allowedTools` and `maxSteps`
  whenever a `characterId` was given.
- Plugin and bot turns could only pick a character and a permission mode.

Patching after the resolver skips everything the resolver enforces at the end:
the tool filter, Restricted Mode, the parent permission ceiling, and the
finalizer that seals the tool surface. The scheduler's replace semantics
dropped the character's denials, the tool filter's, the MCP servers' deny
rules and the IM safeguard, and its `permissionMode` bypassed the whole chain.
The payload model was assigned after the provider was chosen, so a task could
send an Anthropic model id to another provider.

Separately, `resolveTurnAgentMode` never read `ctx.compositionSelection`, so a
connector turn's own composition only reached the transcript stamp while its
prompt delta, tools and authority came from the desktop composer's last choice.

## Decision

### One contract

`packages/agent-config-types/src/agent-capability-grant.ts` defines
`AgentCapabilityGrantV1`:

| Field | Applied where | Direction |
| --- | --- | --- |
| `model`, `provider`, `effort` | head of their resolver chains | replaces, then routed normally |
| `maxTurns` | after the execution policy | replaces |
| `instructions[]` | appended to `appendSystemPrompt` | adds; never replaces the prompt |
| `skills.add` / `.remove` | joins the character's skills / the session's disables | adds / narrows |
| `mcpServers.only` / `.add` / `.remove` | the MCP subset, drawn only from enabled servers | narrows / adds / narrows |
| `tools.add` | the allow list, like a skill's declared tools | adds |
| `tools.deny` | the deny list, re-applied after the plugin hook | narrows |
| `tools.restrictTo` | intersects the allow list after the plugin hook | narrows |
| `knowledgeBases.add` | agent knowledge retrieval | adds |
| `subagents.only` | the native subagent map, after every branch registered it and before `@agent` routing | narrows |
| `permissionMode` | a cap on the resolved mode | narrows only |

`BuildOptionsContext.capabilityGrants` takes an ordered list. The pure helpers
`mergeCapabilityGrants` / `foldCapabilityGrants` compose layers so that denials
are a union no later layer can undo, `restrictTo`, `mcpServers.only` and
`subagents.only` intersect, and permission caps keep the less privileged value.

### Additions are allowed and still clamped

A grant may add a tool, skill, MCP server or knowledge base the character did
not list. Every addition enters before the tool filter, Restricted Mode, the
parent ceiling and `finalizeToolSurface`, so it can never exceed them. An MCP id
that is not enabled in the run's workspace is ignored, never switched on.

### Callers

- **Scheduler:** `buildSchedulerCapabilityGrant` turns the payload into one
  grant. `disallowedTools` now joins the deny list and `permissionMode` is a
  cap. The skill task's skill rides `ephemeralSkillIds`. A deleted agent or a
  skill that is enabled nowhere fails the run instead of running a
  persona-less default.
- **`executeAgent`:** its own knobs become a grant (`executeAgentConfigGrant`):
  with a `characterId`, `model` heads the chain and `allowedTools` restricts.
  `maxSteps` finally reaches the run as `maxTurns`, and `capabilityGrants`
  passes through. The text rail speaks as the named agent. The tool rail builds
  retrieval deps when the agent or a grant binds a knowledge base or a twin.
  User-level memory stays a chat-surface feature.
- **Workflow `action.agent.turn`:** extra skills, MCP servers, knowledge bases,
  denied tools, instructions and a permission cap, with instructions going
  through the node's egress guard.
- **Agent teams:** a teammate's resolved `subagentIds` narrow the team
  session's native subagents with `subagents.only`. An empty list keeps the
  whole team surface, as for MCP servers.
- **Plugins and bots:** `runPluginAgentTurn` and `ctx.agent.run` accept
  `capabilityGrants` (validated, with the caller stamped as source) and a
  composition. Bots pass their whole projected composition.

`resolveTurnAgentMode` takes a caller-owned `selection`, which fixes the
connector split-brain above.

## Consequences

- A run's customisation is one reviewable value, traceable to the feature that
  issued it, and resolved by the same code as the profile it customises.
- Scheduled tasks that relied on `disallowedTools` replacing the agent's
  denials, or on `permissionMode` widening it, now run narrower. That is the
  intended change.
- `runPluginAgentTurn`'s explicit `permissionMode` is still an assignment. It
  is the documented way for a headless plugin to answer "who approves?", and it
  stays a decision at the call site.
- The frozen execution spec (ADR-0090) is still derived from the caller's
  `provider` and `model` fields, not from the agent profile. It drives capability
  gating and the fingerprint, not dispatch.
