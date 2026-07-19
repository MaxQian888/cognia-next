# Claude Code and Codex memory gap analysis

**Date:** 2026-07-18  
**Scope:** Current durable instructions, learned memory, session compaction, subagent context, skills, MCP context, and privacy/security behavior in Claude Code and OpenAI Codex.  
**Method:** Primary sources only: official product documentation and the official `anthropics/claude-code` / `openai/codex` repositories. Product behavior is version-sensitive; this note reflects the sources available on the date above.

## Executive conclusion

The strongest shared lesson is that “memory” is not one store. Both products separate always-on human instructions, model-learned recall, active conversation context, compaction summaries, reusable procedures, and external retrieval. They also treat enforcement as a different layer from model-visible instructions.

For Cognia, the target should therefore be a memory control plane rather than a larger vector store:

1. Distinct artifact types with explicit authority and lifecycle.
2. Scope, provenance, evidence, sensitivity, expiry, and conflict metadata on every learned item.
3. A bounded startup index with lazy detail retrieval and observable token budgets.
4. A visible compaction contract with preview, pinning, structured checkpoints, and loss inspection.
5. Explicit parent/subagent sharing modes and reviewed promotion between namespaces.
6. Trust-boundary controls for MCP, web, screen capture, imported instructions, and cloud extraction.

Claude Code currently leads on project-scoped, directly editable auto-memory; instruction hierarchy; path-scoped rules; compaction transparency; and per-subagent memory scopes. Codex currently demonstrates the more robust asynchronous extraction/consolidation pipeline: eligibility windows, leases, backoff, secret redaction, evidence artifacts, usage-based retention, serialized global consolidation, and per-chat controls. Cognia should combine these strengths rather than copy either product wholesale.

## 1. Durable instructions are not learned memory

### Claude Code

Claude Code distinguishes human-authored `CLAUDE.md` instructions from model-authored auto memory. Its documented instruction order is managed organization policy, user (`~/.claude/CLAUDE.md`), project (`CLAUDE.md` or `.claude/CLAUDE.md`), then local (`CLAUDE.local.md`). Ancestor files are concatenated broad-to-specific; nested files under the launch directory load when Claude accesses that subtree. `.claude/rules/` adds modular rules that may be path-scoped. [`CLAUDE.md` and auto-memory documentation](https://code.claude.com/docs/en/memory)

`CLAUDE.md` can import relative or absolute files with `@path`, recursively up to five hops. External imports require first-use approval. Imports improve organization but do not reduce startup context because they are expanded into context. Claude Code does not directly consume `AGENTS.md`; Anthropic recommends importing or symlinking it from `CLAUDE.md`. [`CLAUDE.md` imports and `AGENTS.md` interoperability](https://code.claude.com/docs/en/memory)

These instructions are model-visible context, not hard policy. Anthropic explicitly separates behavioral guidance from enforced permissions, sandboxing, and managed settings. Hooks are recommended for deterministic lifecycle requirements. [`CLAUDE.md` troubleshooting and enforcement guidance](https://code.claude.com/docs/en/memory), [Claude Code security model](https://code.claude.com/docs/en/security)

### Codex

Codex uses `AGENTS.md`. At session start it reads one global file from `CODEX_HOME` (`AGENTS.override.md` before `AGENTS.md`), then walks from the project root to the current working directory, choosing one instruction file per directory. Files nearer the working directory appear later and therefore take precedence in the combined prompt. The combined project-instruction budget defaults to 32 KiB, and fallback filenames are configurable. [Codex `AGENTS.md` documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

### Cognia implication

Cognia should represent human instructions separately from learned memory and enforced policy. A single “system prompt/memory” bucket cannot express authority, ownership, deterministic precedence, or whether the user can safely delete an item.

Recommended artifact classes:

| Class             | Author                  | Authority              | Typical scope             | Lifecycle                  |
| ----------------- | ----------------------- | ---------------------- | ------------------------- | -------------------------- |
| Enforced policy   | Organization/admin      | Client-enforced        | Organization/workspace    | Versioned, non-overridable |
| Human instruction | User/team               | Model guidance         | User/workspace/path/agent | Editable, precedence-aware |
| Learned memory    | Model with user control | Recall only            | User/workspace/path/agent | Evidence-backed, expiring  |
| Task checkpoint   | Runtime                 | Active-task continuity | Thread/goal               | Replaced or archived       |
| Procedure/skill   | User/team/plugin        | On-demand guidance     | User/workspace            | Versioned, lazily loaded   |
| External context  | MCP/web/file/search     | Untrusted evidence     | Request/session           | Usually non-durable        |

## 2. Learned-memory architectures

### Claude Code: small project index plus lazy topic files

Auto memory is enabled by default and stored per repository under `~/.claude/projects/<project>/memory/`, shared across that repository’s worktrees and subdirectories. `MEMORY.md` is the startup index; only its first 200 lines or 25 KB, whichever comes first, load automatically. Detailed topic files are read on demand. The files are local plain Markdown and can be inspected, edited, or deleted through `/memory`; `/context` reports what loaded. [Claude Code auto memory](https://code.claude.com/docs/en/memory)

This design gives users a simple, auditable project namespace and keeps detailed memory out of the prompt until needed. Its documented format does not define confidence, citations, TTL, contradiction resolution, or semantic retrieval. That is an inference from the published Markdown/index contract, not a claim about undocumented internals.

### Codex: asynchronous two-stage extraction and consolidation

Local Codex memories are off by default. Users can separately control whether a chat consumes existing memory and whether it may contribute to future memory. Codex delays extraction until a chat has been idle, skips short-lived or active sessions, redacts secrets from generated fields, and can skip generation near rate limits. Generated artifacts under `~/.codex/memories/` include summaries, durable entries, recent inputs, and supporting evidence. [Codex memories documentation](https://learn.chatgpt.com/docs/customization/memories)

The official implementation documents a two-phase pipeline:

1. Per-thread extraction claims bounded eligible rollout jobs, filters them to memory-relevant items, produces structured raw memory and rollout summaries, redacts secrets, records success/no-output/failure, and retries failures with backoff.
2. Global consolidation selects a bounded set by `usage_count`, `last_usage`, and age, synchronizes raw memories and per-rollout evidence, computes a diff, and runs a single no-network consolidation agent under a global lock. The workspace maintains a git-style baseline so additions, modifications, and deletions are explicit. [OpenAI Codex memories pipeline source](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md)

Codex also offers a contamination control: `disable_on_external_context` can exclude chats that used MCP, web search, or tool search from future memory generation. Extraction and consolidation models, inactivity windows, age limits, rate-limit thresholds, and use/generate modes are configurable. [Codex memory controls](https://learn.chatgpt.com/docs/customization/memories), [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)

### Cognia implication

Adopt Claude’s scoped, user-auditable project view and Codex’s fault-tolerant pipeline. The minimum durable memory record should contain:

```text
id, type, scope, namespace, content, source_kind, source_id,
evidence_refs, created_at, updated_at, last_used_at, usage_count,
confidence, sensitivity, contamination_state, expires_at,
supersedes, conflicts_with, author, extraction_model, status
```

The canonical store should be structured; Markdown should be an export/edit surface rather than the only database. Generated summaries must not erase their source evidence.

## 3. Session compaction and continuity

### Claude Code

Claude Code auto-compacts near the context limit or accepts `/compact <focus>`. Its documentation publishes an explicit survival table: system prompt/output style remain; project-root `CLAUDE.md`, unscoped rules, and auto memory are re-injected; path-scoped rules and nested `CLAUDE.md` files are absent until matching files are read again; invoked skills are reattached with a 5,000-token per-skill and 25,000-token total cap, newest first. [`What survives compaction`](https://code.claude.com/docs/en/context-window)

Claude Code exposes context accounting through `/context`, accepts user-directed compaction focus, and provides lifecycle hooks. `PreCompact` distinguishes manual and automatic triggers and can block compaction; `PostCompact` receives the generated `compact_summary`. [Claude Code hook reference](https://code.claude.com/docs/en/hooks)

### Codex

Codex supports automatic and manual compaction and a configurable compaction prompt. The official core source replaces history with compacted context and deliberately re-injects initial context differently for standalone versus mid-turn compaction. [Codex compaction source](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs), [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)

Codex exposes `PreCompact` and `PostCompact` lifecycle hooks for manual/automatic triggers, but its current documented hook input contains the trigger and turn ID, not the generated summary. The app-server protocol exposes a `contextCompaction` lifecycle item rather than a documented editable summary payload. This creates a transparency gap relative to Claude Code’s documented `compact_summary` hook. [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex app-server compaction protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

### Cognia implication

Compaction should produce two outputs:

- A model-facing compacted context.
- A structured, user-visible checkpoint containing task intent, completed work, current state, decisions with rationale, files/artifacts changed, verification evidence, unresolved issues, constraints, and “do not repeat” items.

Users should be able to preview/edit the checkpoint, pin facts that must survive, supply a focus, inspect which items were dropped, and restore a pre-compaction checkpoint. Auto-compaction should happen at safe turn boundaries when possible. Post-compaction observability must include the exact summary/version used, token counts before/after, and which durable sources were re-injected.

## 4. Subagents and memory isolation

### Claude Code

Normal subagents start with fresh isolated context and a delegation message. They normally receive the applicable `CLAUDE.md` hierarchy, but built-in Explore and Plan agents omit it; they also do not inherit main-thread auto memory. Resumed subagents retain their own transcripts, which survive parent compaction. Current Claude Code supports nested subagents up to a fixed depth of five and caps model-spawned agents per session. [Claude Code subagent context and persistence](https://code.claude.com/docs/en/sub-agents)

Custom subagents can opt into persistent memory at `user`, `project`, or `local` scope. This creates a distinct namespace for accumulated reviewer/debugger/domain knowledge rather than automatically sharing the main agent’s learned memory. [Claude Code persistent subagent memory](https://code.claude.com/docs/en/sub-agents)

### Codex

Codex subagent workflows move exploration and logs into separate threads and return summaries to the parent. Custom agents can define their own instructions, model, sandbox, MCP, and skills; omitted settings inherit from the parent. The default maximum depth is one and the default open-thread cap is six. Parent runtime sandbox and approval choices are re-applied to children. [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

The Codex memory pipeline explicitly runs only for root sessions, not subagent sessions, preventing every delegated exploration from independently entering the global memory pipeline. [Codex memories pipeline source](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md)

### Cognia implication

Offer explicit sharing modes instead of a boolean “share memory”:

- `none`: delegation prompt only.
- `reference`: child can retrieve parent/workspace memory but cannot mutate it.
- `snapshot`: selected memories copied into child context with source IDs.
- `fork`: full active context cloned.
- `namespace`: child has durable role-specific memory.

Child findings should enter a staging area and require evidence checks or user review before promotion to workspace/user memory. Permission changes, approvals, and confidential context must never be grantable through agent-to-agent messages.

## 5. Skills as procedural memory

Claude Code and Codex both use progressive disclosure: skill names/descriptions are visible for routing, while full `SKILL.md` bodies load only when relevant or explicitly invoked. Claude Code additionally supports a `context: fork` skill, manual-only invocation for side-effecting procedures, per-turn tool grants, and documented post-compaction skill budgets. [Claude Code skills](https://code.claude.com/docs/en/slash-commands)

Codex budgets the initial skill catalog to at most 2% of the model context (or 8,000 characters when the window is unknown), shortens descriptions before omission, and loads the full selected skill afterward. Skills may be scoped to repository, user, administrator, or system locations. [Codex skills](https://learn.chatgpt.com/docs/build-skills)

### Cognia implication

Procedures, domain playbooks, and tool-use recipes should become skills/workflows, not factual memories injected on every request. Cognia should separately measure:

- Routing metadata cost.
- Loaded procedure cost.
- Tool permissions granted by the procedure.
- Whether the procedure survives compaction.
- Version and source of the procedure used for an output.

## 6. MCP and external context

Claude Code supports local, project, user, plugin, connector, and managed MCP scopes. Project servers require trust approval. Tool search loads names initially and defers full schemas until needed; resources can be explicitly attached. Organizations can restrict OAuth scopes, allow/deny servers, or deploy an exclusive managed set. [Claude Code MCP](https://code.claude.com/docs/en/mcp)

Codex supports local STDIO and remote HTTP MCP servers, OAuth/bearer/session authentication, project-scoped trusted configuration, server instructions, enabled/disabled tool lists, and default/per-tool approval modes. Desktop, CLI, and IDE clients on the same host share MCP configuration. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)

External context must not silently become durable truth. Codex’s contamination flag is a useful minimum; Cognia should go further with source-specific trust, immutable evidence references, prompt-injection classification, read/write/destructive annotations, per-tool approval policy, and an explicit promotion flow from external evidence to learned memory.

## 7. Privacy and security controls

Claude Code stores local transcripts in plaintext under `~/.claude/projects/` for 30 days by default and allows `cleanupPeriodDays` to change that. Commercial traffic is not used for model training by default and normally has 30-day server retention; qualified Enterprise organizations can request zero data retention. Consumer retention and training depend on the model-improvement preference. Third-party MCP processing is outside Anthropic ZDR. [Claude Code data usage](https://code.claude.com/docs/en/data-usage), [Claude Code zero data retention](https://code.claude.com/docs/en/zero-data-retention)

Codex local memory is opt-in, stored under `CODEX_HOME`, and supports per-chat use/generate controls and generated-field secret redaction. Individual-service content may be used for training unless the user opts out, while Business, Enterprise, and API inputs/outputs are excluded from training by default. [Codex memories](https://learn.chatgpt.com/docs/customization/memories), [OpenAI data usage](https://help.openai.com/en/articles/5722486-api-data-usage-policies)

Codex Chronicle illustrates the risk of ambient memory capture: it is opt-in, requires screen-recording/accessibility permissions, keeps temporary captures locally, processes selected frames/OCR/path data on OpenAI servers, stores generated memories locally as unencrypted Markdown, and explicitly warns about sensitive content and prompt injection. [Codex Chronicle privacy and security](https://learn.chatgpt.com/docs/customization/chronicle)

Both products separate behavioral instructions from enforced boundaries. Claude Code uses permissions, sandboxing, trust checks, and managed configuration; Codex defaults local execution to an OS-enforced workspace sandbox with network off and layers approvals over sandbox escapes and side-effecting connector/MCP tools. [Claude Code security](https://code.claude.com/docs/en/security), [Codex sandbox](https://learn.chatgpt.com/docs/sandboxing), [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

### Cognia implication

Memory requires its own privacy surface:

- Global and per-chat `use` / `learn` toggles.
- Source allow/deny rules and “never learn from external context.”
- PII/secret redaction before every cloud extraction, embedding, and consolidation call.
- Encryption at rest for local structured memory and protected key storage.
- Configurable retention, TTL, immediate delete, export, and full reset.
- Workspace isolation and explicit cross-workspace sharing.
- Audit log for create/read/update/promote/delete/inject operations.
- Prompt-injection quarantine for screen, web, email, documents, and MCP content.
- Clear disclosure of which provider/model processes memory and its retention/training policy.

## Gap-analysis checklist for Cognia

Use this as an implementation audit. A checkbox should only be marked complete when both the behavior and its user-visible control are verified.

### P0: correctness, trust, and user control

- [ ] Separate enforced policy, human instructions, learned memory, task checkpoints, skills, and external context in the domain model.
- [ ] Give every memory an explicit scope: organization, user, workspace/repository, branch/worktree, directory/path, task/thread, and agent namespace where applicable.
- [ ] Store provenance and evidence references; never leave a summary as the sole proof of a learned fact.
- [ ] Implement deterministic precedence and conflict detection; surface contradictory active memories before injection.
- [ ] Add global and per-chat controls for `use existing memories` and `learn from this chat`.
- [ ] Exclude or quarantine MCP/web/search/screen/connector-derived sessions by policy.
- [ ] Redact secrets and PII before outbound extraction, embedding, or consolidation.
- [ ] Support inspect, edit, delete, export, reset, retention, and TTL controls.
- [ ] Encrypt structured local memory at rest and document where keys and generated artifacts live.
- [ ] Log which memories were injected into each model request and why.

### P0: compaction continuity

- [ ] Define and test a survival matrix for each context type across manual compaction, auto-compaction, resume, fork, and model switch.
- [ ] Generate a structured checkpoint with goal, completed work, active state, decisions, evidence, blockers, next steps, and “do not repeat.”
- [ ] Let users focus, preview, edit, accept, or cancel manual compaction.
- [ ] Show the exact post-compaction checkpoint and token reduction.
- [ ] Support pinned facts and deterministic re-injection of policies/instructions/memory after compaction.
- [ ] Preserve a recoverable pre-compaction checkpoint and prevent repeated compaction loops.

### P1: retrieval quality and lifecycle

- [ ] Use a bounded startup index and lazy-load detailed topic/evidence records.
- [ ] Budget memory, skills, MCP schemas, files, and conversation separately and expose those budgets in the UI.
- [ ] Combine semantic and lexical retrieval with scope filters, recency, confidence, and source trust.
- [ ] Track `last_used_at`, `usage_count`, success feedback, staleness, and supersession.
- [ ] Use bounded asynchronous extraction jobs with leases, idempotency, backoff, and no-output outcomes.
- [ ] Serialize global consolidation and preserve a diff/audit trail of additions, changes, and removals.
- [ ] Revalidate or expire memories when their source file, dependency version, branch, or workspace changes.
- [ ] Evaluate retrieval separately from answer quality with recall/precision, contradiction, contamination, and token-cost tests.

### P1: agents and procedures

- [ ] Provide `none`, `reference`, `snapshot`, `fork`, and `namespace` parent/child context modes.
- [ ] Keep subagent transcripts and memory namespaces independent of parent compaction.
- [ ] Require reviewed promotion from subagent findings to workspace/user memory.
- [ ] Prevent agent messages from granting approvals, permissions, or changing policy.
- [ ] Store procedural knowledge as versioned skills/workflows with progressive disclosure.
- [ ] Allow side-effecting skills to be manual-only and keep tool grants bounded to the invocation.
- [ ] Define which invoked skills survive compaction and the exact per-skill/total budget.

### P1: observability and diagnostics

- [ ] Build a `/memory` equivalent showing scopes, sources, conflicts, age, confidence, sensitivity, and edit/delete controls.
- [ ] Build a `/context` equivalent showing active instructions, memories, skills, MCP tools, token costs, and compaction risk.
- [ ] Explain every retrieval with matched query/scope/source and show why candidates were excluded.
- [ ] Expose extraction/consolidation job status, retries, failures, skipped reasons, and rate-limit deferrals.
- [ ] Add stable lifecycle events for before/after compaction and before/after memory extraction, consolidation, retrieval, promotion, and deletion.
- [ ] Include the generated compact summary/checkpoint in the post-compaction event contract.

### P2: collaboration and portability

- [ ] Support local-only, team-shared, and managed memory with visibly different authority and review flows.
- [ ] Provide safe import/export for `CLAUDE.md`, `AGENTS.md`, Codex/Claude memory Markdown, and Cognia-native structured bundles.
- [ ] Detect instruction imports that cross the workspace boundary and require trust approval.
- [ ] Make worktree/branch sharing explicit instead of accidental.
- [ ] Support cross-device sync only with end-to-end access controls, deletion propagation, and source provenance intact.
- [ ] Add organization policy for allowed memory providers/models, retention, MCP sources, screen capture, and connector learning.

## Suggested implementation order

1. **Model and safety foundation:** artifact taxonomy, scope/provenance schema, per-chat use/learn controls, redaction gate, retention/delete, injection audit.
2. **Compaction checkpoint:** structured schema, preview/edit/pin UI, survival matrix, lifecycle events, recovery.
3. **Retrieval and consolidation:** bounded index, lazy evidence, hybrid retrieval, job leases/backoff, usage/staleness tracking, consolidation diff.
4. **Agent and skill integration:** sharing modes, namespaces, promotion review, procedural-memory budgets.
5. **Collaboration and ambient sources:** team/managed stores, import/export, external-context quarantine, optional screen/connector capture after the privacy model is proven.

## Primary sources

### Anthropic

- [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Explore the context window](https://code.claude.com/docs/en/context-window)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Security](https://code.claude.com/docs/en/security)
- [Data usage](https://code.claude.com/docs/en/data-usage)
- [Zero data retention](https://code.claude.com/docs/en/zero-data-retention)
- [Official Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

### OpenAI

- [Memories](https://learn.chatgpt.com/docs/customization/memories)
- [Chronicle](https://learn.chatgpt.com/docs/customization/chronicle)
- [Custom instructions with `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Sandbox](https://learn.chatgpt.com/docs/sandboxing)
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [How your data is used](https://help.openai.com/en/articles/5722486-api-data-usage-policies)
- [Codex memories pipeline source](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md)
- [Codex compaction source](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)
- [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
