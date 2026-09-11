# A chat surface is wired, or it opts out

**Type:** audit + ADR draft
**Date:** 2026-09-10
**Status:** historical audit and ADR draft. The approved unified IM implementation
is tracked in [the implementation record](../plans/2026-09-10-unified-im-conversations.md).
The capability matrix below describes the pre-change snapshot; it is not the
current implementation. This document has not been promoted to an accepted ADR.
**Prerequisite reading:** ADR-0177 (`docs/content/docs/en/adr/0177-a-room-is-one-conversation-shape.md`, Accepted 2026-09-10)

> **Handoff note.** This document is self-contained. Every claim below carries a
> file path and line number verified against the working tree on 2026-09-10.
> Line numbers may have drifted if other sessions have since edited these files,
> so re-grep the named symbol rather than trusting the number.
>
> **Before promoting this to an ADR:** claim the number by checking
> `docs/content/docs/en/adr/` for the current maximum (0177 at time of writing).
> Several sessions share this tree and ADR numbers have been taken out from
> under a draft before. `scripts/gates/check-adr-catalog.mjs` requires a
> **bilingual** pair, `docs/content/docs/en/adr/NNNN-*.md` **and**
> `docs/content/docs/zh/adr/NNNN-*.md`, plus a `Status` line it can parse. An
> en-only ADR turns the gate red.

---

## 1. Context

### 1.1 What was audited

The main conversation chain, from `app/page.tsx` down to the sidecar event
handler, and every page that participates in it.

`ChatPane` (`components/chat/chat-view.tsx:330`) is the single conversation
component in the app. Its props interface (`ChatPaneProps`,
`components/chat/chat-view.tsx:205`) declares 30 props, of which roughly 20 are
optional capability wires. Five hosts mount it:

| #   | Surface          | Mount site                                                                                           | Route                                   |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Desktop main     | `components/chat/chat-pane-group.tsx:221` (from `components/desktop/desktop-chat-workspace.tsx:712`) | `/`                                     |
| 2   | Mobile main      | `components/app-shell-mobile.tsx:830`                                                                | `/` (compact layout)                    |
| 3   | IM conversation  | `app/inbox/c/page.tsx:195`                                                                           | `/inbox/c`                              |
| 4   | Workbench aside  | `components/context-workbench/resource-workbench-chat-panel.tsx:279`                                 | artifact / canvas / project-file panels |
| 5   | Workflow copilot | `components/workflow/editor/right-sidebar/chat-tab.tsx:360`                                          | `/workflows/editor`                     |

`app/page.tsx:63` picks shell 1 or 2 by `useCompactLayout()`.

Two further conversation surfaces exist outside this chain and are **out of
scope** for this document, because they are deliberate parallel lanes with their
own transports and an explicit escape hatch:

- **Pet chat**, in `hooks/pet/use-pet-chat.ts`,
  `components/pet/pet-chat-transcript.tsx` and
  `components/pet/pet-talk-composer.tsx`. It hands off to the main chain via
  `lib/pet/chat/seed-main-chat.ts` (`components/pet/console/chat-tab.tsx:56`).
- **Remote session view**, in `hooks/data/use-remote-session-stream.ts` plus
  `components/mobile/remote-sessions/remote-session-detail.tsx`, which renders
  `TranscriptMessageList` and its own `ApprovalCard`
  (`components/mobile/remote-sessions/approval-card.tsx`). It shares
  `MessageRenderer` and `PendingDecisionSurface`, so its rendering is not
  drifting. Only its transport differs.

The public share viewer (`app/share/view/page.tsx` into
`components/share/payload-view.tsx`) also renders transcripts through a separate
path. That is intentional, because the viewer ships to Cloudflare Pages and must
not pull the app graph, and it is out of scope.

### 1.2 The measured capability matrix

Prop presence was measured mechanically by extracting each `<ChatPane …/>` JSX
block and testing for `^\s*<propName>=`. Counts are props **passed**, out of 30
declared.

| Capability (prop)                                                                                     | 1 Desktop    | 2 Mobile          | 3 `/inbox/c`      | 4 Workbench       | 5 Workflow        |
| ----------------------------------------------------------------------------------------------------- | ------------ | ----------------- | ----------------- | ----------------- | ----------------- |
| `onSend` / `onStop` / `onRegenerate` / `onEditResend` / `onCreate` / `onUseSample` / `onOpenSettings` | yes          | yes               | yes               | yes               | yes               |
| `onSteerNow`, `onSteerFlush`                                                                          | yes          | yes               | **no**            | **no**            | **no**            |
| `onResumeAfterPlanApproval`                                                                           | yes          | yes               | **no**            | **no**            | **no**            |
| `onSendPlanFeedback`                                                                                  | yes          | **no**            | **no**            | **no**            | **no**            |
| `onRewindFiles`                                                                                       | yes          | **no**            | **no**            | **no**            | **no**            |
| `onCompact`, `onSetModel`, `onResetRuntime`                                                           | yes          | no (IPC fallback) | no (IPC fallback) | no (IPC fallback) | no (IPC fallback) |
| `runtimeNotice`                                                                                       | yes          | **no**            | **no**            | **no**            | **no**            |
| `composerRef`                                                                                         | yes          | yes               | **no**            | **no**            | **no**            |
| `onHeroSend`, `recentSessions`, `onResumeSession`                                                     | yes          | yes               | **no**            | **no**            | **no**            |
| `sessionId`                                                                                           | yes          | no (defaults)     | **no**            | yes               | yes               |
| `showHeader`                                                                                          | default true | `false`           | `false`           | `false`           | `false`           |
| **Total props passed**                                                                                | **27 / 30**  | **18 / 30**       | **9 / 30**        | **10 / 30**       | **12 / 30**       |

Cross-cutting hosts mounted _around_ `ChatPane`, per surface:

| Host                             | 1                                | 2                          | 3                          | 4          | 5          |
| -------------------------------- | -------------------------------- | -------------------------- | -------------------------- | ---------- | ---------- |
| `ToolApprovalDialog`             | `chat-pane-group.tsx:108`        | `app-shell-mobile.tsx:930` | **absent**                 | **absent** | **absent** |
| `ExternalAgentElicitationDialog` | `chat-pane-group.tsx:154`        | `app-shell-mobile.tsx:942` | **absent**                 | **absent** | **absent** |
| `ArtifactWorkspaceDock`          | `desktop-chat-workspace.tsx:698` | `app-shell-mobile.tsx:829` | `app/inbox/c/page.tsx:194` | **absent** | **absent** |
| `AskUserDialog`                  | global, `app/layout.tsx:459`     | global                     | global                     | global     | global     |
| `ComposerReferenceHost`          | global, `app/layout.tsx:413`     | global                     | global                     | global     | global     |

The two globals in `app/layout.tsx` are the pattern this document generalises: a
cross-cutting chat surface that is mounted once, for everyone, and cannot be
forgotten.

### 1.3 Finding 1, the tool-approval gate is host-owned and three hosts do not own it

**Severity: blocks a turn. No user-visible symptom other than "nothing happens".**

`ToolApprovalDialog` is mounted in exactly two files (see matrix above).
`useSessionPendingApprovals` (`stores/chat/chat-store.ts:1451`) has exactly one
consumer, `components/chat/chat-pane-group.tsx:102`.

The routing decision lives in `hooks/chat/claude-chat-events.ts`, case
`"permission_request"` (line 550). After the subagent route and auto-mode
short-circuits, it branches on `isSessionOpen(evt.sessionId)` (line 673):

```
const isOpen = isSessionOpen(evt.sessionId)
if (!isOpen) {
  if (isSessionAttached(evt.sessionId)) { /* remote lease + backstop deny */ return }
  await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not open")
  return
}
if (await tryAutoModeDecision(evt)) return
useChatStore.getState().pushApproval(approval)   // line 728
```

`isSessionOpen` (`hooks/chat/steer-runtime.ts:84`) is
`useChatStore.getState().openSessionIds.includes(sessionId)`. `openSessionIds`
is written by `selectSession` (`stores/chat/chat-store.ts:865`) and
`openSession` (line 876).

This produces **two distinct failure modes**.

**Surface 3, `/inbox/c`: the turn hangs.** The route calls `select(session.id)`
in a mount effect (`app/inbox/c/page.tsx:88` for the hook, lines 91 to 95 for
the effect), so the session **is** in `openSessionIds`. `isSessionOpen` returns
true, `pushApproval` writes the approval into the store, and nothing on the
route renders it. The comment at `hooks/chat/claude-chat-events.ts:683` states
plainly that _"the sidecar's `canUseTool` has no timeout of its own"_. The
backstop-deny timer is armed only on the `isSessionAttached` branch, which this
path never reaches. The turn waits forever, with no dialog, no toast, and no
error.

**Surfaces 4 and 5, workbench aside and workflow copilot: silently
auto-denied.** Neither host registers its session.
`hooks/chat/use-workflow-editor-session.ts` and
`hooks/chat/use-resource-workbench-session.ts` contain no `openSession` or
`select` call. `isSessionOpen` returns false, so every approval takes the
`"auto-denied: session not open"` branch. The reason string is never shown. The
user sees the agent claim it lacks permission for an action they were never
asked about.

Elicitation has the identical shape. `ExternalAgentElicitationDialog` has the
same two mount sites, and `useSessionPendingElicitation` feeds only the desktop
pane gate (`components/chat/chat-pane-group.tsx:142`) and the mobile mount.

`pushApproval` (`stores/chat/chat-store.ts:1052`) also writes a durable journal
row via `writeApprovalJournal`, so on surfaces 3 to 5 the journal accumulates
asks that no surface ever showed.

### 1.4 Finding 2, plan mode is reachable where it cannot be exited

**Severity: blocks a turn.**

`PermissionModeIndicator` cycles `acceptEdits` to `plan` to `default`
(`components/chat/permission-mode-indicator.tsx:5`) and is rendered by **both**
composer toolbars, `components/chat/composer/bottom-toolbar.tsx:307` and
`components/chat/composer/workflow-bottom-toolbar.tsx:91`. Plan mode is
therefore reachable on all five surfaces.

`captureExitPlanMode` runs from the shared event handler
(`hooks/chat/claude-chat-events.ts:898`), so a plan is captured on all five.

But in `ChatPane`:

- `PlanApprovalDock` renders only behind `{boundId && onResumeAfterPlanApproval && …}`
  (`components/chat/chat-view.tsx:906`)
- `PlanTrackerDock` renders on `{boundId && …}` (line 918)
- `PlanComposerDock` renders on `{boundId && …}` (line 926)

On surfaces 3 to 5 the plan is captured, the tracker shows it, and there is no
approve control anywhere in the app.

This exact bug was already found and fixed once, on mobile. The fix comment is
still in the source at `components/app-shell-mobile.tsx`, immediately above
`onResumeAfterPlanApproval`:

> _Plan-mode approval dock, direct-chat only (teams never enter plan mode).
> Without this a plan awaiting approval stranded the turn on mobile: the
> composer can enter plan mode but the dock never rendered._

The same file carries the twin comment for steering:

> _Steer parity with desktop: without these the RunStatusBar's "steer now"
> button never renders and an errored settle would strand the queued steer with
> no flush affordance._

Both fixes were applied to one host and left standing in three others. That is
the strongest available evidence that per-host wiring is the wrong mechanism.

### 1.5 Finding 3, chat-template provenance is silently dropped

**Severity: silent data loss, no turn impact.**

`Composer` always produces a `templateRun` and passes it as the third `onSend`
argument (`components/chat/composer.tsx:3562`, produced at line 1729 by
`templateRunFromBinding`). The controller writes it onto the user message as
`metadata.templateRun` (`hooks/chat/use-claude-chat-controller.ts:1147`).

Surfaces 1 and 2 forward it. Surfaces 3, 4 and 5 declare the parameter as
`_templateRun?: unknown` and discard it:

- `app/inbox/c/page.tsx:154`
- `components/context-workbench/resource-workbench-chat-panel.tsx:143`
- `components/workflow/editor/right-sidebar/chat-tab.tsx:191`

A chat template launched from those surfaces produces a normal turn whose
template run record and backlinks never form.

`turnMetadata`, the fourth argument, **is** forwarded on all three. See
`turnMetadataSendOptions` at `app/inbox/c/page.tsx:160`,
`resource-workbench-chat-panel.tsx:152` and `chat-tab.tsx:206`. Only
`templateRun` is dropped.

### 1.6 Finding 4, more than one chat controller can be mounted and every event is processed by each

**Severity: unbounded duplicate side effects. Confirmed at the code level, not
yet reproduced at runtime.**

`useClaudeChat` is `useClaudeChatController`
(`hooks/chat/use-claude-chat.ts:3`). Each instance subscribes to the sidecar
event stream in its own effect:

```
// hooks/chat/use-claude-chat-controller.ts:555
void onClaudeMessage((evt) => enqueueClaudeEvent(evt as ClaudeEvent))
```

`enqueueClaudeEvent` (line 509) keys a per-instance promise chain by session id
and calls `handleEvent`. There is **no singleton guard** anywhere in the
controller, and `handleEvent` (`hooks/chat/claude-chat-events.ts:252`) has
exactly one early return, for team sub-sessions, which `useTeamChat` owns
(lines 262 to 271). Nothing keys on which instance owns the session.

Two instances are reachable on the desktop root route simultaneously:

- `components/desktop/desktop-chat-workspace.tsx:132` calls `useClaudeChat()`
- `components/context-workbench/resource-workbench-chat-panel.tsx:83` calls `useClaudeChat()`

and the workbench keeps a panel mounted once activated:

```
// components/context-workbench/context-workbench.tsx:1918
if (!active && !activatedIn.includes(panel.id)) return null
```

`ResourceWorkbenchChatPanel` is a `retention: "stateful"` panel registered twice
in `components/artifacts/chat-dock-panels.tsx` (the `resource-chat` panel around
line 181, and the session sidechat panel around line 501, the latter with
`multiAside`). So opening the AI aside once on `/` leaves a second controller
mounted for the rest of the session.

Consequences that follow from the code, ordered by confidence:

- Each instance keeps its **own** `messagesMirrorRef` and independently runs
  `applySdkEvent(current, env.event)` plus the store and Dexie writes
  (`hooks/chat/claude-chat-events.ts:786` onward).
- `pushApproval` (`stores/chat/chat-store.ts:1052`) appends **without deduping
  on `requestId`**, so one permission request produces two store entries and two
  approval-journal rows. `clearApproval` filters by `requestId`, so clearing
  does remove both. The store converges, the journal does not.
- Non-idempotent per-turn side effects in `handleEvent`, namely `trackEvent`,
  `startSpan` and `endSpan`, `projectDirectChatSdkMessage`,
  `captureExitPlanMode`, and execution-run start and finish, run once per
  mounted instance.

**This has not been reproduced at runtime.** It should be, before the fix is
scoped: mount `/`, open the AI aside, send one turn, and count `handleEvent`
invocations. If the duplicate processing turns out to be benign for message
content, the fix is still warranted for the side effects, but the priority
changes.

### 1.7 Finding 5, the gap is already swallowing work landed today

ADR-0177 batch B1 shipped `lib/chat/room/` on 2026-09-10, including
`projectRoomParticipants` and the roster projection whose entire `im` branch
exists to answer "who is in this IM group".

Its only UI consumer is `RoomParticipantsChip`
(`components/chat/room-participants-chip.tsx:70`), mounted in exactly one place:

```
// components/chat/chat-header.tsx:159
<RoomParticipantsChip session={session} />
```

`/inbox/c` passes `showHeader={false}` (`app/inbox/c/page.tsx:196`) and renders
its own `ConversationHeader` instead, which does not include the chip.
`components/inbox/conversation-header.tsx` mounts `PlatformBadge`,
`ModeSwitcher`, `ThreadMembershipChip`, `ContactProfileDrawer`,
`ConversationOverrideDialog`, `CallbackBindingsInspector`,
`ConversationHeaderOverflow` and `ArtifactDockToggle`.

The IM group roster is therefore visible on `/` and invisible on `/inbox/c`, the
route that exists for IM conversations. This is not historical debt. It is the
surface gap consuming a feature the same day it landed.

`showHeader={false}` on surfaces 3 to 5 also removes `BranchLineageChip`,
`BranchChildrenChip`, `MentionBacklinksChip`, `PlanModeTasksSheet`,
`SessionEnvironmentChip`, `SessionSettingsSheet`, `SharedSessionPanel`,
`ImportedOriginChip`, and the `PluginExtensionSlot` that carries plugin
chat-header contributions. Surfaces 2 and 3 substitute their own headers.
Surfaces 4 and 5 substitute nothing.

### 1.8 Why this recurs

The repository already names this class of session, for **data**, not for
**capability**:

```ts
// lib/chat/session-exposure.ts:42
export function isEmbeddedSession(session: ExposableSession): boolean {
  return (
    session.visibility === "embedded" ||
    session.kind === "resource-workbench" ||
    session.kind === "workflow-editor" ||
    session.kind === "subagent"
  )
}
```

That predicate governs listing, search, plugin enumeration, connector surfaces
and export, via `SessionExposureChannel`. It has no counterpart governing what an
embedded chat _surface_ must wire. So:

- TypeScript accepts 9 props out of 30. Every capability wire is optional, and a
  wire that blocks a turn when missing is typed identically to one that changes
  an empty-state string.
- The repository has roughly 50 gates in `scripts/gates/`, including three
  parity gates of exactly this shape (`check-host-parity.mjs`,
  `check-adapter-capability-parity.mjs`, `check-rpc-semantic-parity.mjs`), and
  none covers chat surfaces.
- `check-unreachable-components.mjs` catches a component with no consumer. It
  cannot catch a component with a consumer that forgot a prop.

### 1.9 What ADR-0177 already settled, do not reopen

ADR-0177 (Accepted, 2026-09-10) decided the **model** layer. This draft must not
contradict it.

- A room is a conversation with more than two participants. `RoomKind` is
  `team | shared | im`, classified by `roomKindOf(session)`
  (`lib/chat/room/kind.ts:20`), reading `collaboration`, then `kind` plus
  `teamId`, then `platformBinding`.
- **IM is a `RoomKind`, not a `SessionKind`.** `SessionKind` remains
  `"direct" | "team" | "workflow-editor" | "resource-workbench" | "subagent"`
  (`packages/agent-config-types/src/index.ts:2039`).
- Squad is an executor, not a conversation shape.

The audit independently supports this. IM-ness and conversation shape are
orthogonal axes today:

- `createPlatformSession` writes `kind: "direct"` **plus** `platformBinding`
  (`lib/connectors/session-bindings.ts:152`).
- Both `app/inbox/c/page.tsx:145` and the mobile shell carry live
  `session.kind === "team" && session.teamId` branches for platform-bound
  sessions.
- `ChatSession.squadId`'s own doc comment already reasons in axes: _"A team is a
  conversation shape ... A Squad is an executor, the same axis as a model or a
  subagent, so any conversation can be bound to one regardless of its kind."_
- The `sessions` Dexie index already carries `platformConversationKey` as its own
  column (`lib/db/schema.ts:435`), so the lookup needs no new shape.

Folding `im` into `SessionKind` would collapse the shape axis into the transport
axis and break the team-shaped IM conversation that already exists.

ADR-0177 also already repaired one approval hole, but a different one:

> _"Approvals for a room with no open pane now follow the direct-chat rule: a
> remote device holding a control lease on the room decides, a backstop denies
> if it never answers, anything else is denied."_

That is the **no open pane** case. Finding 1's `/inbox/c` failure is the **open
pane with no gate mounted** case, which 0177 does not address.

### 1.10 Two lists over one table (context, not a decision)

Recorded because it explains why the split feels arbitrary, but this draft does
**not** propose merging the lists.

The same `sessions` table is read by two conversation lists:

- `components/inbox/conversation-list.tsx:107`,
  `db.sessions.filter((s) => s.platformBinding != null)`. 365 lines, full
  platform chrome.
- `components/desktop/channel-list.tsx`, 3,367 lines, with **zero** references
  to `platformBinding`, so IM conversations appear in the main list with no
  platform indicator at all. `components/desktop/session-row.tsx` likewise has
  none.

`components/chat/chat-header.tsx:181` already renders a button that jumps a
platform-bound session from `/` to `/inbox/c`. The codebase knows both doors
reach the same row. The same IM conversation therefore behaves correctly when
opened from `/` and hangs when opened from `/inbox/c` (Finding 1). Same row,
same `ChatPane`, different host.

---

## 2. Decision (draft)

> Working title: **A chat surface is wired, or it opts out.**

### D1, `ChatPane` owns every gate that can block a turn

Three surfaces move _into_ `ChatPane`, keyed on the pane's bound session id
(`boundId`), so a host cannot fail to mount them:

1. the tool-approval gate (today `PaneApprovalGate`, `components/chat/chat-pane-group.tsx:91`)
2. the elicitation gate (today `PaneElicitationGate`, `components/chat/chat-pane-group.tsx:136`)
3. the plan-approval dock (today gated on `onResumeAfterPlanApproval`, `components/chat/chat-view.tsx:906`)

The test for "does this belong inside `ChatPane`" is: if the host omits it, does
a turn stop making progress with no way for the user to unblock it? If yes, it
is not a host concern.

`chat-pane-group.tsx` keeps rendering the panes and the split logic. It stops
owning the gates.

### D2, `ChatPane` owns open-session registration

`ChatPane` registers its `boundId` in `openSessionIds` on mount and unregisters
on unmount, so `isSessionOpen` answers "a pane is showing this session", which is
what `hooks/chat/claude-chat-events.ts:673` actually needs to know.

This closes both halves of Finding 1 at once:

- surfaces 4 and 5 stop being auto-denied, because their pane now registers
- `/inbox/c` stops leaking global state. The route can drop its
  `select(session.id)` effect (`app/inbox/c/page.tsx:91`), which today also
  hijacks the global `activeSessionId` and never calls `closeSession` on
  unmount, so every visited IM conversation accumulates in `openSessionIds`.

**Care required.** `selectSession` and `openSession` are distinct actions
(`stores/chat/chat-store.ts:855` and `876`). `ChatPane` must use `openSession`
(pane visibility), never `selectSession` (global focus). Unregistering must not
call the existing `closeSession` action (line 877), which deletes the session
slice and re-focuses another tab. A background pane unmounting must not tear
down state the desktop tab strip still owns. This likely needs a new refcounted
`retainSession` and `releaseSession` pair, since two panes can show the same
session (split view, `chat-pane-group.tsx:207`).

### D3, opting out is explicit, typed, and visible

A host that genuinely must not offer one of the D1 gates declares it, rather
than achieving it by omission. Proposed shape:

```ts
/**
 * Capabilities this host deliberately does not offer. Every entry needs a
 * reason. The parity gate reads them.
 */
suppress?: readonly ChatSurfaceCapability[]
```

Whatever the mechanism, the requirement is that "this surface has no approval
gate" is a statement someone wrote, not a prop someone forgot.

### D4, non-blocking wires stay host-supplied but are inventoried

`onRewindFiles`, `onSteerNow` and `onSteerFlush`, `onSendPlanFeedback`,
`runtimeNotice`, `composerRef`, and the welcome trio `recentSessions`,
`onResumeSession`, `onHeroSend` stay props, because they need host context
`ChatPane` does not have. They move from "silently absent" to "listed in a
baseline" (D6).

`templateRun` (Finding 3) is not a capability. It is a data channel the host must
not sever. The three `_templateRun?: unknown` signatures should be fixed
directly, as part of this work.

### D5, one chat controller per process

`useClaudeChat` gains a single-subscriber guarantee, so N mounted callers share
one sidecar subscription, one event queue, and one `messagesMirrorRef`.

The likely shape is a module-level singleton holding the subscription and the
mirror, with the hook returning a view onto it. That mirrors what ADR-0177
already did for rooms: _"The desktop's `useTeamChat` and the `room_send` arm
share one runner per process."_ Independently, `pushApproval`
(`stores/chat/chat-store.ts:1052`) should dedupe on `requestId`, which is correct
regardless of how D5 lands.

**Reproduce Finding 4 before implementing D5.** The fix is warranted for the side
effects either way, but its priority depends on whether message content is
actually corrupted.

### D6, a parity gate, ratcheted

`scripts/gates/check-chat-surface-parity.mjs`, modelled on
`scripts/gates/check-host-parity.mjs` and its `host-parity-baseline.json`:

- enumerate every `<ChatPane` call site
- for every capability in the contract, require the prop, an entry in
  `suppress`, or an entry in `chat-surface-parity-baseline.json`
- the baseline may only shrink

Register it in `scripts/gates/check-gate-registry.mjs` and in the gate list in
`CLAUDE.md`.

---

## 3. Suggested batches

| Batch                     | Scope                                                                                                                                                                                                                                                    | Primary files                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1, stop the bleeding** | D1 and D2. Move the approval gate, elicitation gate and plan-approval dock into `ChatPane`, add refcounted pane registration, drop the `select()` effect from `/inbox/c`.                                                                                | `components/chat/chat-view.tsx`, `components/chat/chat-pane-group.tsx`, `stores/chat/chat-store.ts`, `app/inbox/c/page.tsx`                                                        |
| **B2, the contract**      | D3 and D4. Type the capability set, add `suppress`, fix the three `_templateRun` drops.                                                                                                                                                                  | `components/chat/chat-view.tsx`, `app/inbox/c/page.tsx`, `components/context-workbench/resource-workbench-chat-panel.tsx`, `components/workflow/editor/right-sidebar/chat-tab.tsx` |
| **B3, the gate**          | D6.                                                                                                                                                                                                                                                      | `scripts/gates/check-chat-surface-parity.mjs`, `scripts/gates/chat-surface-parity-baseline.json`, `scripts/gates/check-gate-registry.mjs`, `CLAUDE.md`                             |
| **B4, one controller**    | D5, after reproducing Finding 4. Also dedupe `pushApproval` on `requestId`.                                                                                                                                                                              | `hooks/chat/use-claude-chat-controller.ts`, `stores/chat/chat-store.ts`                                                                                                            |
| **B5, header parity**     | Decide per surface whether the `showHeader={false}` hosts re-expose `RoomParticipantsChip`, `MentionBacklinksChip`, `BranchLineageChip` and `PluginExtensionSlot`, or declare them suppressed. Coordinate with ADR-0177 B4, which also touches `/inbox`. | `components/chat/chat-header.tsx`, `components/inbox/conversation-header.tsx`, `components/context-workbench/`, `components/workflow/editor/right-sidebar/`                        |

---

## 4. Verification

Each batch must land with evidence, not assurances.

**Manual reproduction, do this first, before B1:**

1. `pnpm dev`, open an IM conversation at `/inbox/c`, trigger a tool that needs
   approval. Expect the turn to hang with no dialog. Confirm the approval is in
   the store, at `useChatStore.getState().sessions[id].pendingApprovals`.
2. Open the same conversation from `/`. The main channel list shows it, because
   it is `kind: "direct"`. Expect the dialog to appear and the turn to complete.
3. Open the workflow editor chat tab, trigger the same tool. Expect silent
   denial, and confirm `"auto-denied: session not open"` in the console.
4. Enter plan mode on any of surfaces 3 to 5, let the agent call the exit-plan
   tool. Expect the tracker to render and no approve control to exist.
5. On `/`, open the AI aside, send one turn, and instrument `handleEvent` to
   count invocations per event (Finding 4).

**Tests.** Every touched file under `components/**`, `hooks/**`, `lib/**` and
`stores/**` needs its co-located test updated or added (hard rule 3). At
minimum, add a test that mounts `ChatPane` with a pending approval and **no**
host-supplied gate, and asserts the dialog renders. That test is the regression
lock for Finding 1.

**Gates.**

```bash
pnpm typecheck && pnpm lint && pnpm lint:i18n && pnpm audit:colocated-tests
```

```bash
pnpm test -- components/chat hooks/chat stores/chat app/inbox
```

Then `/preflight` for the six auditors, and `tauri-smoke` if any IPC path moves.
Note the `pnpm test` argument order: test paths must come **first**, before any
variadic flag.

---

## 5. Open questions for the implementer

1. **Refcounting `openSessionIds`.** Split view means two panes can bind the
   same session (`components/chat/chat-pane-group.tsx:207`). Naive
   register-on-mount and unregister-on-unmount will unregister a session another
   pane still shows. Decide the counter's home before writing D2.
2. **Does `/inbox/c` want the approval dialog, or an inline card?** A modal over
   an operator inbox may be the wrong shape. `PendingDecisionSurface`
   (`components/chat/decisions/pending-decision-surface.tsx`) is already the
   shared body behind both `ToolApprovalDialog` and the mobile remote-session
   `ApprovalCard`, so an inline variant is cheap.
3. **Ordering against ADR-0177 B4**, which touches `lib/connectors/**` and the
   inbox. Check with whoever owns that batch before B5.
4. **Does the workflow copilot want plan mode at all?** If not, the honest fix is
   to suppress the `PermissionModeIndicator`'s plan entry there
   (`components/chat/composer/workflow-bottom-toolbar.tsx:91`) rather than to add
   a dock. That is a D3 `suppress` decision, and it must be made deliberately,
   not by omission.

---

## 6. Working-tree cautions

- **This tree is shared with other agent sessions.** Commit with
  `git commit --only <your paths>`. Never `git add .`, `git stash`,
  `git checkout -- .`, `git reset --hard`, or any branch switch. See working
  rule 8 in `CLAUDE.md` and the `concurrent-tree-safety` skill.
- `components/chat/composer.tsx` (3,811 lines),
  `hooks/chat/use-claude-chat-controller.ts` (3,568) and
  `lib/claude/build-options.ts` (4,672) are all actively edited by other
  sessions. Check `git diff -- <path>` before staging any of them.
- A user-facing behaviour change here needs `pnpm changeset` with the
  `cognia-next` package, `patch` or `minor`, per working rule 6.
- At the time of writing, the machine's disk was full and shell commands
  returned `ENOSPC`. If that recurs, the known-safe reclaim in this repo is the
  Cargo `target/` `_up_` and `incremental` directories.
