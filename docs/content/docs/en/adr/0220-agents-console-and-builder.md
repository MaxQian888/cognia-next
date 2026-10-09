---
title: "0220 — Agents get their own console and a conversational builder"
description: "Custom agents (Character rows) move from Settings to a top-level /agents console laid out like Cognia's other consoles: a rail of every agent and one profile page per agent (activity, open work, facts, capabilities) with an edit mode and a full-width task board mode. An agent can name a default runtime (Character.runtime) that a new conversation with it switches to. A new agent can be built by conversation: a hidden builder session on the runtime and model the user picks gets agent_builder_* tools and a protocol, fills a live draft beside the chat, and creates the agent only with the user's approval or the manual button."
---

# ADR 0220 — Agents get their own console and a conversational builder

**Status:** Accepted
**Date:** 2026-10-09
**Related:** [ADR-0030](./0030-character-pack-overlay-capability) (character packs),
[ADR-0199](./0199-an-agent-variant-follows-its-base) (variants),
[ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (per-run grants),
[ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background) (built-in tool family pattern),
[ADR-0132](./0132-issue-tracker) (issues assigned to an agent)

## Context

A custom agent is a `Character` row. The only place to manage one was Settings → Characters: a long
list with a thousand-line inline form. Nothing showed what an agent was doing, what it had done or
what it cost; creating one meant filling every field by hand; and an agent could not say which
runtime (the built-in lane, a local external agent such as Codex or Claude Code, or a host
configuration) it should run on, so every new conversation with it started on whatever the composer
last used.

## Decision

### 1. One home: `/agents`

The agent list moves to a top-level `/agents` route; it is not copied. Settings → Characters keeps
what is not per-agent (character packs, knowledge bases) and an entry card that links to `/agents`.
Every entry point that opened agent management is retargeted and its old code removed: File → New
agent (`new-agent` menu id, Rust menu and command parity included) opens `/agents?new=1`, ⌘K
`manage-agents` opens `/agents`, the goal tracker opens its agent in edit mode, the Me row on a
phone opens `/agents`, and `app/me/characters` is deleted. Every "watch this agent task" link (the
issue tracker's federated agent-task rows, the workspace's "Agents working" list) opens the task's
own agent on its board (`agentTaskBoardHref`) instead of the Settings section that no longer has one. The `"character"` kind leaves
`pendingCreateRequest`. The rail gains an `agents` entry with its surface contract, go-menu section
and full-viewport route.

Static export: the view is query state on one route (`?id=&mode=edit|tasks`, `?new=1|blank|ai`,
`?builder=<sessionId>`, rail `?q=&source=&sort=`), the `/squads` pattern.

### 2. Laid out like Cognia's other consoles

A full-width table and a four-tab detail were tried first and dropped: they read as a different
product and spread little information over mostly empty pages. The console uses the shape of
`/squads`, `/bots` and `/skills`:

- **Rail.** Every agent as a list row (avatar with live dot, name, a status word only when it is
  working or waiting on you, built-in badge, description). Search, source chips that carry their
  counts, a sort menu, and a select mode with a batch bar (export, delete). The same component is a
  phone's root list.
- **Centre, nothing selected.** The characters spot illustration, the two ways to create an agent,
  and every unfinished builder draft. The same view is the "New agent" landing.
- **Agent profile, one page.** A masthead (who it is; Chat, Assign work, Edit or "Duplicate to edit",
  the lifecycle menu), then two columns from the container's `4xl`: an activity feed (live first,
  then finished conversations, tasks and issues) and the open work; beside them About (origin,
  runtime, models, permission, working directory), the last 30 days, and capabilities as compact
  rows. `?mode=edit` swaps the profile for the form.
- **Open work, drawn like the issue tracker.** Unfinished durable tasks and open assigned issues are
  one list, newest first, with the tracker's own status and priority glyphs (a task maps onto them
  as the tracker's agent-task source maps it). An issue row opens the issue; the section links to
  `/issues?assignee=agent:<id>`, a new deep link that filters the console to the agent.
- **The task board is its own mode, not embedded.** `?mode=tasks` gives the eight-column kanban the
  whole body under the masthead. Issues cannot replace it: the tracker only federates tasks that
  belong to a workspace, and read-only, while the board is where a task is run, paused, reviewed
  and commented on.

Activity is derived, never stored: sessions by `characterId`, agent tasks by `agentId`, issues by
assignee, spend from `sessionUsage`, live state from the chat store's run status.

### 3. `Character.runtime` — an agent's default runtime

`CharacterRuntimeBinding` is `builtin`, `external` (agent id) or `host` (configuration id). When a
conversation is started with an agent through the single new-chat path (`startNewSession`), the
binding is applied to the session's runtime lane; the composer can still change it per
conversation. A binding that cannot be honoured here (an external agent not installed on this
device, a host configuration that is gone, disabled or unreachable) leaves the app default in place
and raises the `agentRuntimeUnavailable` diagnostic, so the fallback is never silent. The field's
account-sync policy is `local` (an external agent id is machine-local), and it is not exported into
character packs.

### 4. Build with AI

A builder conversation is a `ChatSession` of kind `agent-builder`, `visibility: "embedded"`, so it
never reaches the conversation list, search or connectors. Its `agentBuilder` state holds the draft,
a revision, who edited last, and `drafting | created` (sync policy `local`: a draft names this
device's servers, knowledge bases and runtime).

- **Setup** reuses one pristine builder session and binds the composer's own runtime and model
  pickers to it, so every lane and every model surface works exactly as in chat. The runtime chosen
  here becomes the new agent's default runtime.
- **Tools** follow the built-in tool family pattern: `agent_builder_get_draft`,
  `agent_builder_list_catalog` (skills, plugin skills, MCP servers, knowledge bases, models),
  `agent_builder_update_draft` (a validated patch; unknown ids are rejected with the valid set) and
  `agent_builder_create_agent`. The ruleset allows all of them except `create_agent`, which asks.
  They are surfaced only on a session of the builder kind, and the runner re-checks the kind and
  refuses edits once the agent is created. External runtimes reach them through the renderer tool
  host.
- **Protocol** in the system prompt, and the current draft as a per-turn dynamic section.
- **Workspace**: the chat beside the controlled agent form. Builder writes are adopted by revision;
  the user's own edits are written back debounced and never overwritten by their echo. "Create &
  open" is always available, so a runtime that cannot call Cognia tools still ends in an agent
  (setup and the chat header say the user fills the draft themselves).
- Unfinished drafts are listed wherever creation starts; discarding one deletes its session.

### 5. One editor, one set of actions

The agent form (`CharacterEditor`) moves to `components/agents/editor/` with a controlled mode and
the runtime field; the editor ↔ `Character` conversion is one pure module
(`lib/agents/editor-state.ts`); every row action (duplicate, variant create / detach / reset,
export, pack update, delete) is one hook (`useAgentActions`). The rail, the profile, the builder and
the phone all use these; nothing is drawn twice.

## Consequences

- Settings → Characters is short: packs, knowledge bases and a link.
- An agent's default runtime is a property of the agent, not of whichever conversation last ran.
- A builder session costs a normal chat turn on the chosen model; nothing is created without the
  user's approval or click.
- Builder sessions are local to the device by design; a synced device sees no draft.
