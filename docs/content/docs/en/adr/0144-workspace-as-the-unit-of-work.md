---
title: "0144 — The workspace is the unit of work"
description: "One repository plus N execution slots becomes the thing conversations, schedules, capabilities, panels and search all attribute to — with concurrency serialized per slot rather than per app, and every surface that speaks for the whole app forced to stop describing only the conversation on screen."
---

# ADR 0144 — The workspace is the unit of work

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0111](./0111-managed-workspace-registry), [ADR-0090](./0090-unified-agent-execution), [ADR-0129](./0129-unified-global-search), [ADR-0128](./0128-scheduler-host-neutral), [ADR-0122](./0122-first-run-onboarding), [ADR-0042](./0042-notification-center), [ADR-0136](./0136-cross-device-placement)

## Context

Multi-conversation had been built and never surfaced. `ChatSession.projectId`
has existed since Dexie v86 with a `[projectId+updatedAt]` compound index; the
chat controller keys every mutable value by session id; the execution broker is
a sixteen-permit semaphore, not a lock. The foundation was sound. What was
missing was that nothing above it agreed on which workspace anything belonged
to, and several things that spoke for the whole app described only the
conversation the user happened to be looking at.

Three defect classes, all of them invisible until a second workspace or a
second conversation existed:

**Mis-attribution.** A turn resolved its working directory through a six-source
fallback chain that did not include the session's own `executionContext`, so a
conversation bound to a managed worktree ran its commands in the checkout that
worktree was cut from. A new conversation was stamped with the store's
`activeProjectId`, which leads the persisted `AppSettings.activeProjectId` by
one async write — start a chat immediately after switching workspaces and it
was attributed to the one you just left. Skills and MCP servers were
machine-wide with no way to say "this Jira server belongs to the work repo".

**Lying.** `useChatStore` mirrors the FOCUSED session's slice onto the store's
top level so ~130 legacy call sites keep working. The tray, the status bar and
the mobile shell all read that mirror, so with two background turns streaming
and a quiet conversation on screen, every one of them said "Idle". ⌘K defaulted
to `workspace: all` and only two of nineteen providers honoured the filter, so
every search leaked other workspaces' conversations and memories with nothing
marking them as foreign. A notification saying "needs approval" could not name
the workspace or the conversation that raised it.

**Half a model.** The scheduler had no workspace at all — only a free-text `cwd`
in its payload. The terminal, the editor and Source Control each computed their
root differently and none read the execution context. Nothing in the product
ever proposed adopting the directories it was demonstrably already working in.

## Decision

### The workspace is one repository plus N execution slots

Not multi-repo-per-workspace, and not a Workspace > Project two-layer model. A
workspace mounts roots; the SLOTS are the working trees inside it — the main
checkout, each managed worktree, each remote sandbox. That distinction is what
the rest of this ADR rests on: attribution is per workspace, and exclusion is
per slot.

Attribution is forced and correctable. Every conversation, schedule and
capability delta names a workspace; a conversation can be moved to another one
(`lib/chat/move-session-workspace.ts`), and moving is refused while it is
running, because a running turn's cwd cannot be changed underneath it.

### The execution context is the single source of the working directory

`SessionExecutionContext` was already durable and already correct. The legacy
six-source cwd chain degrades to a creation-time seed; `resolveEffectiveCwd`
and `resolvePanelRoot` both resolve from the binding.

`resolvePanelRoot` is the one rule for every panel that operates on a
directory: pin → the conversation's execution root → the workspace's primary
root → nothing. Pinning is offered ONLY to panels whose job includes comparison
(Source Control, the editor, search — "what does this look like on main" is a
real question), and a pin on an execution panel is **ignored rather than
obeyed**, so a stale pin cannot aim a shell at a tree the agent is not working
in. Every panel renders its resolved root, and says when it is a worktree alias
rather than the user's own checkout.

### Capabilities are overlaid, never owned

Skills and MCP servers stay defined once for the machine. A workspace records
only deltas — capability id → on/off, absent inherits — on its own row, the
same shape `terminalConfig` and `knowledgeSettings` already use.

A `projectId` column on the definition tables was rejected: it would make a
definition BELONG to a workspace, so the same MCP server would need
re-registering and re-authorising per workspace and would vanish from the
library when its workspace was deleted.

One mechanism, not the "allowlist plus overrides" pair sketched during design:
both answer the same question, and two ways to say "this is on" is how surfaces
start disagreeing. The enabled set is a projection, not a second store. This
also matches what mature editors do — VS Code's "Disable (Workspace)" is a
per-extension delta, not a workspace manifest.

**Plugins are excluded on purpose.** `plugins.enabled` is the runtime's loaded
state, written by `manager.setPluginIntent` as a consequence of activation.
Overlaying it per workspace would rewrite the record of what is actually
running on every switch. Doing it properly needs a second column separating
"installed and enabled by default" from "loaded right now" — a definition-table
change this layer exists to avoid.

### Concurrency is serialized per slot, not per app

The broker's cap answers "how much work is running". It never answered "may
these two run in the SAME directory", and two conversations bound to one
checkout fit comfortably under sixteen permits and then interleaved edits,
builds and git operations in one tree.

A lease may name the execution slot it mutates; the broker admits at most one
leg per slot. Three properties hold it together:

- The continuation exemption comes first. An exempt leg IS the work already
  holding the tree; making it wait on its own slot would deadlock its
  conversation.
- The slot is claimed at ADMISSION, not at acquire — a leg only waiting for a
  permit must not hold a directory nobody is working in.
- Freeing a directory does not create a permit, so a slot waiter re-enters the
  ordinary admission path. The pool drain runs first, so a longer-queued permit
  waiter keeps its place.

### Surfaces that speak for the app read the app, not the focused pane

`aggregateRunState` derives the app-wide answer once, with `awaiting_approval`
above `streaming` (it is the only state that needs the user) and `error` above
`idle` but below both live states (an old failure must not mask a running
turn). The tray, status bar, title-bar pill and mobile shell all read it. The
composer's draft state moved into the per-session slice, so a focus change
re-projects rather than wipes and the unfocused split pane stops writing into
the pane beside it.

### Search scopes to the current workspace; entities filter, definitions demote

`workspace` defaults to `current`. An entity — a conversation, a memory, an
issue — belongs to a workspace and out of scope is noise. A definition does
not: hiding a skill this workspace switched off produces the worst possible
search result, "I know I have this and it is not there", so it ranks below what
the workspace uses and stays findable. A row with NO workspace is shared, not
foreign, so it always passes. The dialog names the workspace it is confined to,
with one click to widen: a default the user cannot see is indistinguishable
from a search that is simply missing things.

### Notifications label the source and never filter

A cross-workspace reminder is the feedback loop that makes concurrent work
possible; folding the centre down to the active workspace would throw away half
of what it is for. Records carry their source workspace and the row names it —
but only when it differs from the workspace on screen.

## Consequences

**What this buys.** A conversation's tools now point where the conversation is
working. Two workspaces can run at once without their schedules, searches,
skills or servers bleeding into each other, and without two turns fighting over
one tree. The app stops claiming to be idle while it is busy.

**What it costs.** `SchedulerDatabase` gains a v5 index and a boot-time
backfill — the backfill cannot live in the upgrade hook, because the answer is
in the main database and reaching across Dexie instances from inside an upgrade
transaction deadlocks. A pre-v5 row whose creator names no session is left
unattributed rather than guessed at: for a user with five workspaces, stamping
it with whatever was active at upgrade time would be wrong four times out of
five and would silently rebind their schedule.

**Deliberately not done.** Cross-workspace split view, pop-out windows, true
per-workspace isolation of the definition tables, and `.cognia/workspace.json`
as a wired source (it is marked dormant, not read). Mobile is a "concurrency
visible" client — it can see and reach background runs and remotely start
work — but is not a workspace host.

**What the gates hold.** Five, each guarding a defect where the wrong code is
the shorter thing to write: a baselined projection/cwd audit
(`pnpm audit:workspace-attribution`), per-provider search-scope classification,
i18n catalogue coverage for the dynamic keys `lint:i18n` skips, and three-axis
dormancy pinning for the two deliberate refusals above.

**Relationship to ADR-0111.** This closes the "non-chat scheduler executors are
not proven Registry-only" P0 by giving a schedule a workspace and routing its
root through the unified resolver. ADR-0111 itself stays **Proposed**: the
registry's own lifecycle questions are untouched here.

**Correction to ADR-0122.** Its claim that first run cannot produce a project
folder no longer holds — onboarding now offers to open or create one, and
`AppSettings.projectsRoot` gives that a default parent.
