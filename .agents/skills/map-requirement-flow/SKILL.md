---
name: map-requirement-flow
description: >-
  Turn raw product, feature, workflow, or process requests into complete, traceable end-to-end Requirement Flows by
  identifying actors, scenarios, triggers, underlying goals, preconditions, dependencies, happy paths, branches,
  exceptions, observable success criteria, system ownership across pages, agents, tools, backend services, data, and
  telemetry, plus journey gaps and open decisions. Use when asked to 梳理需求, 拆需求动线, 补充异常分支, 分析用户流程,
  检查动线断点, 映射 Page/Agent/Tool/Backend, 完善 user story or acceptance criteria, audit an existing flow, or make a
  rough requirement behaviorally complete before a PRD, prototype, technical proposal, E2E plan, user-path mindmap, or
  implementation.
---

# Map Requirement Flow

Turn an input requirement into a behaviorally complete, evidence-backed flow that product, design, engineering, QA, and
agent/tool owners can review without reconstructing intent. Analyze the requirement; do not silently turn analysis into
implementation, publication, or external writes.

## Choose the operating mode

Infer the lightest mode that satisfies the request:

- **Build**: Create a Requirement Flow from raw text, a conversation, an issue, or a document. This is the default.
- **Audit**: Review an existing flow for missing actors, states, branches, criteria, ownership, or traceability.
- **Delta**: Update only the affected steps and show the before/after impact when a requirement changes.
- **Code-aware**: Use with any mode when the request concerns the current product or repository. Verify current surfaces,
  contracts, and capabilities before labeling them as existing.

Use text-only analysis when no product implementation is in scope. Do not inject Cognia architecture merely because the
workspace is open.

Match depth to risk while preserving completeness: keep a single-actor reversible flow compact; use the full tables and
an optional state/sequence visual for cross-system, asynchronous, destructive, privacy-sensitive, or high-reliability
requirements.

## Establish evidence before modeling

1. Read the complete source request and any linked issue, PRD, conversation, design, screenshot, or journey artifact.
2. Separate evidence into:
   - **Confirmed**: Explicit in the source or verified in current code, configuration, tests, docs, or a live surface.
   - **Inferred**: A reasoned conclusion supported by confirmed facts.
   - **Assumed**: A reversible working choice used to continue.
   - **Open**: A decision or fact that materially affects the flow and cannot be discovered.
3. When the current repository is in scope, read applicable `AGENTS.md`, relevant ADRs, owning implementation, callers,
   routes, state/storage, tests, and existing user journeys before mapping system ownership.
4. Use the narrowest available evidence tool:
   - structural code graph for symbols, callers, and blast radius when a current index and tool are available;
   - language-server navigation for TypeScript/JavaScript definitions, references, and diagnostics;
   - `rg` for literal text and filenames;
   - current official documentation or web research for version-sensitive external facts;
   - browser or E2E tooling for observable UI behavior;
   - the relevant Lark skill for Lark-hosted source material.
5. Do not ask for facts that available tools can discover. Ask at most one load-bearing question at a time when different
   answers would materially change the flow; include a recommended answer and its consequence. Otherwise proceed with a
   labeled assumption.

## Model the requirement

### 1. Frame the requirement

Extract and normalize:

- primary, secondary, administrative, and system actors;
- scenario, user state, channel, platform, and timing context;
- initiating trigger and entry point;
- stated request versus underlying user goal;
- desired terminal outcome and value;
- scope, non-goals, and policy constraints.

State the underlying goal as an outcome, not a proposed UI or technical mechanism. If it differs from the stated request,
explain the inference and preserve both.

### 2. Identify preconditions and dependencies

Cover applicable requirements for account/authentication, permissions, entitlement, prior state, data availability,
configuration, feature flags, installed tools or connectors, external systems, network, platform, timing, privacy,
compliance, and upstream/downstream contracts.

Distinguish:

- **Precondition**: Must be true before entry.
- **Runtime dependency**: Needed while the flow executes.
- **Policy constraint**: Restricts allowed behavior.
- **Open dependency**: Required but not yet owned or confirmed.

### 3. Build the Happy Path

Assign stable IDs such as `HP-01`. Start at a reachable entry and end at an observable terminal state.

For every step record:

- actor and intent;
- action, event, or decision;
- system response;
- state or data transition;
- user-visible feedback or machine-visible signal;
- next step;
- owning surface or capability;
- linked success criteria.

Keep each step atomic enough to fail independently. Split asynchronous request, progress, completion, cancellation, and
result-consumption states when they have different ownership or failure behavior.

### 4. Add branches and exceptions

Attach every branch to a Happy Path step using IDs such as `BR-HP03-01`. Cover applicable cases:

- alternative user choices and early exit;
- empty, missing, invalid, stale, or conflicting input;
- authentication, authorization, entitlement, or consent failure;
- timeout, offline state, cancellation, retry, and resume;
- duplicate, concurrent, out-of-order, or idempotent actions;
- partial success and compensating behavior;
- agent, tool, connector, backend, storage, or third-party failure;
- destructive or irreversible actions;
- cross-device, cross-session, platform, and compatibility differences.

Give every branch a recovery path, re-entry point, fallback, escalation, or explicit terminal outcome. Do not write a free-
floating exception list that cannot be traced to a step.

### 5. Define observable success

Assign IDs such as `SC-01`. Make each criterion observable from UI, a public contract, persisted state, telemetry, or an
approved test seam. Include applicable criteria for completion, feedback, persistence, recovery, idempotency,
permissions, accessibility, performance bounds, privacy, and cross-platform consistency.

Avoid “works correctly,” implementation-only claims, or criteria that merely repeat the feature name. Do not invent a
numeric threshold; mark it Open when product or operational policy must provide one.

### 6. Map system ownership

Map each step and branch across the applicable layers:

- Page or UI surface;
- Agent or orchestration role;
- Tool, connector, or integration;
- Backend, native service, sidecar, or external service;
- data, state, cache, queue, or persistence;
- analytics, logs, metrics, traces, or audit events.

For every mapping label the capability as:

- `Existing`: Verified in the current system, with evidence.
- `Change`: Exists but must change.
- `New`: Required by the flow and not currently implemented.
- `TBD`: Ownership or existence cannot yet be established.
- `N/A`: Deliberately not applicable; use sparingly.

Separate required future behavior from confirmed current implementation. Never invent route names, APIs, tools, agent
abilities, backend jobs, analytics events, or owners.

In text-only mode, name logical capabilities and behavioral invariants rather than speculative APIs, schemas, tables, or
entity types. When a hard requirement implies a technical property such as idempotency, ordering, or durable recovery,
state the invariant and acceptable implementation class; leave the concrete mechanism to a technical design unless the
user requests one.

### 7. Audit journey gaps

Check for:

- unreachable entry, missing exit, or dead end;
- hidden prerequisite or missing permission path;
- action without feedback or state without an owner;
- branch without recovery or re-entry;
- async work without pending, cancellation, timeout, or stale-result behavior;
- cross-surface handoff that loses context or identity;
- requirement without a flow step;
- flow step without success evidence;
- success criterion without a verification seam;
- required system capability without a user-facing path;
- duplicate ownership, contradictory behavior, or undefined source of truth.

Classify gaps as `Blocker`, `Major`, or `Minor`. Give each gap an impact, evidence status, and the next decision or owning
role; do not disguise a gap as an assumption.

### 8. Close traceability

Assign source requirement IDs such as `REQ-01` when the input has no stable IDs. Trace each source clause to its Happy Path
steps, branches, success criteria, and system owners. Preserve unmatched requirements and unbacked flow steps as explicit
findings.

## Coordinate with other skills and tools

Read [`references/integration-routing.md`](references/integration-routing.md) when the task needs upstream discovery,
deeper product decisions, prototyping, technical design, test planning, journey governance, implementation, or publishing.

Treat routing as a handoff, not permission to expand scope:

- invoke another skill only when it is available and its trigger is satisfied;
- pass the Requirement Flow IDs, evidence statuses, gaps, and open decisions so downstream work remains traceable;
- do not install a missing skill or plugin unless the user explicitly requests it;
- do not create a PRD, proposal, issue, prototype, test, implementation, Lark document, or whiteboard unless requested;
- after downstream work, reconcile any changed decisions back into the Requirement Flow instead of allowing silent drift.

## Deliver the result

For Build and Delta modes, read and follow
[`references/output-template.md`](references/output-template.md). For Audit mode, retain the source structure when useful,
then report the same evidence, gap, and traceability fields.

Default to delivering in the conversation. Save a Markdown artifact only when requested, using the repository's current
document location and naming convention. Match the user's language while preserving stable IDs and technical identifiers.

Before completion, read and execute
[`references/completion-checklist.md`](references/completion-checklist.md). Report unresolved Blockers and Open decisions;
do not claim the flow is complete when a gate fails.

## Red lines

- Do not silently invent product decisions to make the diagram look complete.
- Do not confuse a user goal with a requested UI or implementation.
- Do not model only the Happy Path.
- Do not list errors without recovery, ownership, or terminal behavior.
- Do not mark a capability Existing without current evidence.
- Do not bury unresolved decisions inside prose or `TBD` cells.
- Do not start implementation or external publication on implied consent.
- Do not produce a large ceremonial document when a small flow fully covers the behavior.

## Resources

- [`references/output-template.md`](references/output-template.md): canonical Requirement Flow output contract.
- [`references/completion-checklist.md`](references/completion-checklist.md): behavior, evidence, coverage, and handoff gates.
- [`references/integration-routing.md`](references/integration-routing.md): conditional routing to repository tools and adjacent skills.
