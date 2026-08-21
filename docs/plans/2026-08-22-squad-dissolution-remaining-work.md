# Squad dissolution — the two pieces left, and the traps in them

**Status:** Handoff
**Date:** 2026-08-22
**Related ADRs:** ADR-0140 (decision), ADR-0022, ADR-0032, ADR-0045, ADR-0066, ADR-0117

ADR-0140 landed everything except two pieces. Both were deferred for the same
reason: another workstream was rebuilding the same files at the same time, and
committing over live work is not recoverable. Neither is blocked on a decision
— the decisions are in the ADR. They are blocked on the files being free.

## 1. One board, two hosts

**Goal.** `/issues` and the Squad task board render the same thing twice.
`lib/issues/board-model.ts` says so in its own header, and
`lib/issues/state-machine.ts` says its ownership model is "deliberately
identical to `lib/ai/agent/team/task-move-guard.ts`". Both export a
`columnDropId`, a `parseDndId`, a `resolveDrop`, a `buildXColumns`, a
`buildXSwimlanes`, an `applyXFilter` and a `reorderXColumn`, near line-for-line.

**What is actually shared vs. what only looks it.**

|                   | `components/issues/board/issue-board.tsx`               | `components/agent/workspace/board/task-board.tsx`                                         |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| statuses          | 6 (`ISSUE_STATUSES`)                                    | 8 (`BOARD_COLUMN_ORDER`)                                                                  |
| drop-id namespace | `col:<status>`                                          | `col:<status>`                                                                            |
| guard input       | `(capabilities, from, to, {runActive})`                 | `(task, from, to, teamStatus)` — needs `task.dependencies` **and** the team's live status |
| guard shape       | permissive; denies federated + `in_progress` while live | restrictive whitelist; `blocked` is machine-only both ways                                |
| denial            | returned to the caller, board is silent                 | **toasts inside the board**                                                               |
| writes            | `onDrop` → console → Dexie                              | **calls `useAgentTeamStore` directly**                                                    |
| filter state      | owned by the console                                    | **owned by the board**                                                                    |
| toolbar           | sibling                                                 | **child**                                                                                 |
| plugin slots      | none                                                    | `agent.team.board.toolbar`, `agent.team.task.actions`                                     |

**Cheapest high-value slice:** share the four pure functions first
(`columnDropId` / `parseDndId` / `resolveDrop` / `reorderColumn`). The React
shell is ~60% shared chrome and ~40% genuinely divergent affordances, and the
divergences above are the abstraction's real cost.

**Traps.**

- `PLUGIN_POINTS` maps each point to an owning file (`plugin-points.ts`
  ~473-477) and a test asserts that map. Moving a slot means moving its entry.
- `components/agent/agent-task-board.tsx` and
  `components/mobile/agent-teams/team-board-mobile.tsx` are **not** variants of
  these two. The first is a different domain (`AgentTask`, `status:<s>` drop
  ids, `useDraggable` with no reorder concept). The second is CQRS over the
  Dexie mirror with a Sheet action list and no dnd at all. Leave both alone;
  folding them in makes a fifth board, not fewer.
- Team tasks already appear on `/issues` read-only via
  `lib/issues/sources/agent-team-source.ts`. Making them writable there means
  crossing two guard vocabularies, which both files' headers say they avoided
  on purpose. ADR-0140 chose "shared renderer, two hosts" over that.

**Known projection gaps in that source, worth fixing while you are there:**
`tags` is hard-coded to `labelIds: []`, and the assignee is forced to the team
even when `claimedBy` names a teammate. The 8→6 status collapse is deliberate
and documented — leave it.

## 2. Deleting `/agent-teams`

**What has to move first (all of it is still live on that page):**

| Tab                               | Destination              | Notes                                                                         |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| overview / members / settings     | Settings → Squads        | library shipped; the 11 governance sections have no home yet                  |
| tasks                             | shared board (piece 1)   |                                                                               |
| chat                              | **delete**               | done — the whole `lib/agent-team/runtime-streamers` path with it              |
| activity / operations / worktrees | `/agent-runs` run detail | needs the section registry below                                              |
| editor                            | `/agent-runs` run action | resolve the working dir first (`lib/execution/run-workspace.ts`, not written) |
| command centre                    | `/squads`                | done                                                                          |

**The run-detail registry.** `components/agent-runs/run-detail-pane.tsx` has
six literal `<TabsTrigger>`s and no registry; its own header already points at
a plan to consume `components/chat/run-panel.tsx` instead. Whichever way that
goes, three traps apply:

- **`hasLiveBrokerLeg`** (`lib/execution/monitor-model.ts:173`). While a team
  run is live the row can be `source: "broker"`, with **no `runId` and no
  `allowedActions`**. Any section keyed on `row.runId` is blank exactly while
  the run is worth looking at. Key on `row.sourceId → agentTeamRuns` instead.
- **`ConsensusPanel` and `DelegationsPanel` take no props.** They read the
  agent-team store's _currently selected_ team. Dropped into the cockpit they
  would show whatever the old workspace last selected. Parameterising those
  selectors by `teamId` is the single largest cost in that move.
- **Mobile syncs `executionRuns` and nothing else** — not events, not
  interrupts, not `agentTeamChildRuns`. Every new section needs the
  `Unavailable` treatment (`run-detail-pane.tsx:366`) or it renders a confident
  empty on a phone.

**Then, and only then:** delete `app/agent-teams/**`, redirect to `/squads`,
rewrite the regex guards in `page.mount.test.ts`, flip
`lib/runtime/surface-contract.ts`'s `agent-teams` entry out, and split the
850-leaf `agentTeamsWorkspace` i18n namespace across `squads` / `agentRuns` /
`settings/squads`.

## Also outstanding

- **Uncommitted files under `/agent-runs`.** `run-detail-pane.tsx`,
  `use-execution-run-detail.ts`, `run-detail-model.ts` and the
  `ExecutionStatusPill` export exist only in a working tree. A commit that
  imports them does not build from a clean checkout — this already happened
  once and was fixed in `9a24a4e0f`. Check `git cat-file -e HEAD:<path>` before
  importing anything from that area.
- **Pre-existing reds, not caused by this work:**
  `components/chat/composer.slash-popover.test.tsx` (6),
  `components/shell/guild-rail.test.tsx` chrome budget (10 vs 9),
  `components/shell/member-list.test.tsx`, `lib/settings/builtin-tools.test.ts`.
- **Mobile.** `components/mobile/agent-teams/team-workspace-mobile.tsx` is
  hosted by the page being deleted. ADR-0140's scope was "read-only list +
  run status via the `/squads` responsive fallback"; that fallback exists, the
  mobile fork does not yet route to it.
