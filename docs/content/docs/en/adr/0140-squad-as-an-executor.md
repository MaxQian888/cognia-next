---
title: "0140 — Squad as an executor"
description: "Agent teams stop being a place you go to and become something a conversation can be handed to; the nine-tab workspace is dissolved into the surfaces that already own each of its parts."
---

# ADR 0140 — Squad as an executor

**Status:** Accepted
**Date:** 2026-08-22

> **Amended by ADR-0169 (2026-09-05).** The `agentTeamManager` control surface, the `/squads` command centre and the optimistic `team.status` this document wired are superseded: one durable runtime, one review contract, one control machine, and the `/squads` Runs tab is the `/agent-runs` panel.

## Context

`/agent-teams` and `/agent-teams/workspace` were six surfaces wearing one
route: a library, a fleet command centre, a template gallery, a kanban board,
a chat tab, and eleven accordions of governance. Nothing about it could be
read as any one thing, and the parts that duplicated other surfaces had drifted
apart from them — four kanban boards, five template listings, two plan-approval
panels, three vocabularies for a stat tile.

Underneath the presentation problem was a structural one. **The chat surface
could not reach a team at all.** ADR-0045 recorded this in its own context
table: the only chat→team path was the `action.team.run` workflow node. What
existed instead was a chat tab inside the workspace, and that tab was a
demonstration rather than a product surface:

- It rendered the real `<Composer>` but passed no `session`, so the model
  picker became an inert chip, the effort selector returned `null`, the
  attachment UI mounted and then refused every send, and slash commands,
  `#memory`, `!shell` and web search all acted on the *main* chat instead.
- Its send path bypassed `resolveSendOptions` entirely. The system prompt was a
  hardcoded constant. No skills, memory, twin, MCP, hooks, permission ceiling
  or tool approval.
- Its transcript was never persisted — the store's `partialize` excludes
  `messages` — so history was lost on reload.
- It required a leading `@mention` and refused the turn without one.

Meanwhile the seam this all needed already existed and had one consumer.
`AGENT_ORCHESTRATION_POLICIES` (ADR-0117) has included `team` since it shipped,
with `orchestrationRef` to carry the target and a picker already on screen. The
IM lane honours it. Desktop chat ignored the axis.

Finally, the word "team" names two unrelated things here: a *character team*
(`session.kind === "team"`, several personas in one room — a conversation
shape) and an *agent team* (an orchestrated squad — an executor). Both were
called "team" in the UI.

## Decision

**A Squad is an executor, on the same axis as a model or a subagent.** A
conversation can be handed to one; it is not a place you navigate to.

1. **Rename.** Agent Team → **Squad** (中文「小队」). Character Team keeps
   "Team" (「团队」). One is a conversation shape, the other is who runs it.

2. **The binding is a column, not the composition axis.**
   `ChatSession.squadId` (Dexie v177, indexed). The axis is device-local
   zustand; a binding has to survive a reload, reach a second device and be
   visible to the conversation list. The axis still *carries* the id for a
   single-turn override — which is what its own doc always said it was for.

3. **Routing happens above `resolveSendOptions`, never inside it.** That
   function answers "how do I run one model turn"; a Squad run is not one. The
   chat controller branches to `startSquadRun` before any direct-chat
   bookkeeping — exactly where the IM lane already branched, and its module
   header already said so: *no second executor, no `resolveSendOptions`
   change*.

4. **One primitive, two surfaces.** `startSquadRun` is host-neutral and wraps
   `runTeamLifecycle` — the same primitive `action.team.run` uses, so a Squad
   turn gets the whole pipeline. What differs per surface is only the
   `triggeredFrom` origin, whether there is a channel to ask a human on, and
   whether a connector binding is wanted.

5. **The conversation holds while the Squad works.** The session stays
   `streaming` until the run settles, so a follow-up queues as steering through
   the existing steer path instead of starting a second Squad over the first.

6. **One message, steps folded away.** A Squad's members are implementation
   detail. One message per member would flood the transcript and would collide
   with the character-team room, where several characters genuinely *are* the
   conversation.

7. **Dissolve the workspace.** Configuration → Settings, beside the other
   cross-conversation assets. Runtime → `/squads`. Per-run detail →
   `/agent-runs`. Conversation → the conversation.

8. **Say what a surface cannot do.** `resolveComposition` has always accepted
   `supportedOrchestrations`; no chat caller passed it, so all five policies
   looked selectable and three did nothing. Chat now declares `direct` and
   `team`, and names why each of the others is not selectable — two are
   reachable another way, one is not built.

## Consequences

- The chat tab, its 448-line bespoke renderer, its copied tool-call card,
  token line and three-item action menu, and the whole `runtime-streamers`
  send path are removed.
- Old Squad chat history is discarded. It was never persisted; nothing is lost
  that a user could have expected to find.
- `/agent-teams` stays routable and declared until its own removal lands, but
  drops out of navigation. The rail id was renamed with a legacy alias applied
  on read — the id doubles as the persistence key, so renaming it without one
  would delete the item from every saved layout rather than move it.

## Amends

- **ADR-0022** — the team runtime stays the single orchestrator, but the team
  *surface* is no longer where a team is used. Also: that ADR's persistence
  claim (teams/teammates/tasks in memory only) has been false since persist v4
  and is corrected here.
- **ADR-0032** — team capability configuration moves to the Settings library.
  `<PresetEditor>` remains the single teammate editor; nothing forks.
- **ADR-0045** — the chat→orchestration seam it specified is now closed on the
  desktop surface, not only via `teammate_dispatch` inside a plan.
- **ADR-0066** — unchanged in substance. The board keeps its guard, its CQRS
  projection, its Companion RPCs and its plugin points; only its host moves.
- **ADR-0117** — the orchestration axis gains a real consumer, and gains a
  storage-of-record for its `orchestrationRef` rather than owning it.

## Deferred

Two pieces are deliberately not in this change, because another workstream was
rebuilding the same files concurrently:

- **Sharing one board component** between `/issues` and the Squad task board.
- **Deleting `/agent-teams`** and its workspace, with the redirect and the
  `agentTeamsWorkspace` i18n namespace split that follows.

Both are recorded in `docs/plans/` with the specific traps involved.
