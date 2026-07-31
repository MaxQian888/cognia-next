---
name: cognia-tech-proposal
description: >-
  Turn a Cognia feature, fix, migration, protocol change, or architectural decision into an implementation-accurate,
  review-ready technical proposal. Use when asked to write or review a technical design, design doc, RFC, TRD, 系分,
  技术方案, 评审材料, or implementation plan for Cognia across Next.js UI, shared TypeScript libraries, Tauri/Rust crates,
  CLI/sidecars, mobile/Capacitor, plugins/SDKs, services, data/schema, deployment, or cross-layer contracts. Determine
  light/standard/heavy depth, research current code and ADRs, tailor sections to touched layers, document alternatives and
  rationale, cover compatibility/security/privacy/observability/migration/rollback/testing, run structural review gates,
  create a source-controlled Markdown proposal, and optionally publish an approved copy to Lark. Use cognia-e2e for E2E
  implementation itself and subsystem-docs for bilingual product documentation; this skill owns the proposal and review.
---

# Cognia technical proposal

Produce a document another engineer can implement without rediscovery and reviewers can approve without guessing. The output must be source-accurate, conclusion-first, quantified, explicit about non-goals, and honest about unknowns.

Do not treat this skill's module list, counts, or sample commands as permanent truth. Read the current repository before drafting.

## Workflow

### 0. Establish facts

Before writing:

1. Read root and nearest `AGENTS.md`.
2. Read the request/PRD/issue completely. For Lark sources, invoke `lark-doc`; do not rely on a title or excerpt.
3. Inspect the current diff, owning implementation, callers/consumers, tests, config, migrations, CI, deployment manifests, and relevant ADRs.
4. Find 1–2 current Cognia proposals/ADRs in the same subsystem as structural exemplars.
5. Record evidence status:
   - **Confirmed**: verified in current code/config or by a command.
   - **Inferred**: conclusion from confirmed evidence.
   - **Open**: requires a product/technical decision or unavailable environment.
6. Quantify current state from commands; never copy historical counts without rerunning.

Research before creating new mechanisms. Extend existing modules and contracts when they own the behavior.

### 1. Choose depth and sections

The user may override depth.

| Depth | Trigger | Required shape |
|---|---|---|
| Light | One layer, no schema/public contract, reversible UI/refactor/small fix | Context/goals/non-goals → design → tests → risks → work plan → decisions |
| Standard | Two layers or one stored/public/native contract | Full core sections from `section-model.md` |
| Heavy | 3+ layers, schema/migration, security/privacy, protocol/SDK, native IPC, deployment, multi-account, costly/irreversible change | Core sections plus alternatives, compatibility, rollout/rollback, observability, dependency matrix, phased delivery |

Read [`references/section-model.md`](references/section-model.md), select only applicable sections, and remove inapplicable sections instead of leaving empty `N/A` placeholders.

Before expanding a non-trivial proposal, present:

- proposed depth;
- final outline with a one-sentence conclusion per section;
- 3–5 line executive summary;
- known open decisions.

Continue when the user has already specified the shape or asked for autonomous completion; otherwise treat outline agreement as the first review checkpoint.

### 2. Draft conclusion-first

Use [`references/pyramid-and-emphasis.md`](references/pyramid-and-emphasis.md):

- open with an executive summary: what, why, impact, decisions needed;
- organize context with SCQA (situation, complication, question, answer);
- make section titles carry conclusions;
- start each section with its result, then evidence and rationale;
- group arguments MECE;
- give every material choice a “why this / why not alternatives” explanation.

Use current numbers for files, call sites, tests, latency, storage, binary size, requests, or affected commands. If a number cannot be measured, label it as an estimate with method and confidence.

### 3. Model behavior and change

Read [`references/diagram-cookbook.md`](references/diagram-cookbook.md). Create a diagram only when it makes a relationship clearer:

- 3+ components in a data/control path → architecture/data-flow diagram;
- 3+ dependent steps or async callbacks → sequence/swimlane;
- 4+ states or recovery transitions → state machine;
- schema/entities → ER or mapping table;
- alternatives/repeated fields → comparison matrix;
- rollout phases/dependencies → milestone/dependency view.

Write the message first, then choose the visual. Every diagram has a one-sentence conclusion. Keep a diffable Mermaid/ASCII source in Markdown. Upgrade only important review visuals to a Lark whiteboard.

### 4. Cover implementation contracts

For every applicable boundary, specify:

- owner and consumers;
- input/output types and validation boundary;
- state transitions, idempotency, ordering, cancellation, timeout, retry, and recovery;
- compatibility with stored data, older clients/plugins/SDKs, Tauri/Capacitor/web, and external agents;
- security, permissions, secrets, PII redaction, path/workspace isolation, and trust boundaries;
- observability: logs, metrics, traces, audit events, cardinality, thresholds, and operator action;
- migration/backfill/rollback and failure containment;
- tests at the narrowest owning layer plus cross-layer/E2E coverage.

For repository-specific traps and gates, read [`references/repository-conventions.md`](references/repository-conventions.md).

### 5. Review the draft

Read [`references/review-checklists.md`](references/review-checklists.md) completely and fix every applicable finding. At minimum verify:

- proposal matches current implementation paths and symbols;
- goals map one-to-one to acceptance;
- non-goals and deferred work are explicit;
- alternatives have a recommendation and rationale;
- happy path, failure path, recovery, compatibility, migration, and rollback are covered;
- security/privacy/permissions and external side effects are covered;
- tests and CI commands prove the stated behavior;
- work packages have dependencies, unique owners/owner roles, and independent verification;
- all open questions are review decisions, not hidden implementation gaps.

### 6. Save and optionally publish

Save the canonical Markdown to `docs/plans/YYYY-MM-DD-<topic>.md` unless an ADR or user-specified location is more appropriate. Use ISO date and preserve the repository's current plan style.

Use [`assets/proposal-template.md`](assets/proposal-template.md) as a starting point, then delete placeholders and inapplicable sections.

If the user requests only an outline, review, diagnosis, or read-only assessment, return that artifact without creating or editing a proposal file.

For Lark publishing, read [`references/publishing.md`](references/publishing.md) and invoke the appropriate Lark skills. Publishing is a separate external write:

1. keep Markdown as canonical source;
2. confirm destination;
3. create/update the document without destructive overwrite unless explicitly approved;
4. fetch back and verify the rendered content;
5. return both local path and remote link.

Do not publish merely because a local proposal was requested.

### 7. Close review

End the proposal with:

- decisions required, numbered `Q1...Qn`, each with options and recommendation;
- review record table;
- TODOs with a single owner/role and ISO DDL;
- implementation phases with verification and rollback conditions;
- sources/evidence paths.

## Writing rules

- Quantify vague claims or mark them as hypotheses.
- Explain every important design decision.
- Use tables/diagrams/code blocks for structure; avoid walls of prose.
- State non-goals and deferred work.
- Use one term per concept across UI, protocol, storage, code, and docs.
- Cover abnormal paths; do not document only success.
- Separate confirmed facts, inference, proposal, and open decisions.
- Do not paste speculative production code as if implemented.
- Do not create stubs, “TODO later” designs, or unowned follow-up.
- Do not rewrite unrelated repository documentation.

## Resources

- [`references/section-model.md`](references/section-model.md): depth, layer-based section selection, and content contracts.
- [`references/repository-conventions.md`](references/repository-conventions.md): current Cognia architecture, hard gates, and subsystem traps.
- [`references/pyramid-and-emphasis.md`](references/pyramid-and-emphasis.md): conclusion-first and SCQA structure.
- [`references/diagram-cookbook.md`](references/diagram-cookbook.md): message-first visual selection and templates.
- [`references/review-checklists.md`](references/review-checklists.md): proposal lint and domain review gates.
- [`references/publishing.md`](references/publishing.md): safe Markdown-to-Lark workflow.
- [`references/source-index.md`](references/source-index.md): current repository evidence and exemplar discovery.
- [`assets/proposal-template.md`](assets/proposal-template.md): complete standard proposal skeleton.
