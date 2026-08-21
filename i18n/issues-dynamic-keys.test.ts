/**
 * Catalogue coverage for the issue tracker's DYNAMIC message keys.
 *
 * `pnpm lint:i18n` compares literal `t("…")` calls against a baseline; a key
 * built at runtime — `t(`status.${issue.status}`)`, `t(`run.refusal.${reason}`)` —
 * is invisible to it. The issue surface is built almost entirely out of those:
 * six statuses, five priorities, four sources, eighteen event kinds, ten
 * refusal reasons, three denial reasons. Adding a member to any of those enums
 * without adding its message ships a raw enum value into the UI, in both
 * locales, with every gate green.
 *
 * So the enums are the source of truth here and the catalogues are checked
 * against them — in BOTH locales, because a key present only in English fails
 * silently for everyone else.
 */

import enMessages from "./messages/en.json"
import zhMessages from "./messages/zh-CN.json"

import type { TaskMoveError } from "@/lib/ai/agent/team/task-move-guard"
import { ISSUE_GROUP_BY_OPTIONS } from "@/lib/issues/board-model"
import type { IssueFilterFacet } from "@/lib/issues/filter-chips"
import { AGENT_TASK_RUN_ADAPTER_ID } from "@/lib/issues/run/agent-task-adapter"
import { AGENT_TEAM_RUN_ADAPTER_ID } from "@/lib/issues/run/agent-team-adapter"
import { GITHUB_LOOP_RUN_ADAPTER_ID } from "@/lib/issues/run/github-loop-adapter"
import type { IssueRunRefusalReason } from "@/lib/issues/run/types"
import type { IssueMoveDenial } from "@/lib/issues/state-machine"
import { ISSUE_LIST_DENSITIES, ISSUE_SORT_MODES, BUILTIN_ISSUE_VIEWS } from "@/lib/issues/views"
import type { IssueActorKind, IssueEventKind } from "@/types/issues"
import {
  ISSUE_PRIORITIES,
  ISSUE_PROJECT_STATUSES,
  ISSUE_RUN_KINDS,
  ISSUE_RUN_STATUSES,
  ISSUE_STATUSES,
} from "@/types/issues"
import { ISSUE_SOURCE_KINDS } from "@/types/issues/unified"

/**
 * Unions that have no runtime constant, written as an exhaustive map.
 *
 * `Record<Union, true>` is the point: a missing member is a TYPE error at
 * build time, and a typo is one too. A hand-typed `as const` array would
 * compile happily while quietly dropping the member whose message is missing —
 * which is exactly the failure this file exists to catch.
 */
function exhaustive<K extends string>(map: Record<K, true>): K[] {
  return Object.keys(map) as K[]
}

/** Every reason `canMoveIssue` can return. */
const MOVE_DENIALS = exhaustive<IssueMoveDenial>({
  "federated-read-only": true,
  "runtime-owned": true,
  "illegal-transition": true,
})

/** Every reason an `IssueRunAdapter` can refuse with. */
const RUN_REFUSALS = exhaustive<IssueRunRefusalReason>({
  "assignee-kind-mismatch": true,
  "assignee-not-found": true,
  "team-busy": true,
  "no-github-ref": true,
  "no-github-repo": true,
  "desktop-only": true,
  "no-github-account": true,
  "run-active": true,
  "issue-finished": true,
  "adapter-missing": true,
})

/** Every `IssueEvent["kind"]`, which the activity trail renders one line for. */
const EVENT_KINDS = exhaustive<IssueEventKind>({
  created: true,
  status_changed: true,
  assigned: true,
  unassigned: true,
  reassigned: true,
  priority_changed: true,
  label_added: true,
  label_removed: true,
  title_changed: true,
  description_changed: true,
  project_changed: true,
  commented: true,
  run_started: true,
  run_succeeded: true,
  run_failed: true,
  artifact_linked: true,
  github_linked: true,
  github_write_back: true,
})

/** Every `TaskMoveError` the Agent Team board localizes on a refused drop. */
const TASK_MOVE_DENIALS = exhaustive<TaskMoveError>({
  "blocked-column": true,
  "runtime-owned": true,
  "illegal-transition": true,
  "task-not-found": true,
})

/** Every actor kind, plus the two sentinels the pickers render. */
const ACTOR_KEYS = [
  ...exhaustive<IssueActorKind>({ human: true, agent: true, team: true }),
  "unassigned",
  "noLead",
]

/** The screen-reader announcements the board builds at drag time. */
const DND_KEYS = ["instructions", "pickedUp", "over", "denied", "dropped", "cancelled"] as const

/**
 * The facet names the filter chips localize.
 *
 * Keyed by `IssueFilterFacet` so a new facet on `IssueBoardFilter` fails to
 * compile here; the VALUES differ from the keys because the message catalogue
 * names them in the singular.
 */
const FILTER_FACET_KEYS = Object.values({
  query: "query",
  priorities: "priority",
  labelIds: "labels",
  assignees: "assignee",
  sources: "source",
  issueProjectIds: "project",
} satisfies Record<IssueFilterFacet, string>)

/** The three registered adapters, by the id `IssueRun.adapterId` carries. */
const ADAPTER_IDS = [
  AGENT_TASK_RUN_ADAPTER_ID,
  AGENT_TEAM_RUN_ADAPTER_ID,
  GITHUB_LOOP_RUN_ADAPTER_ID,
]

const LOCALES = { en: enMessages, "zh-CN": zhMessages } as Record<string, unknown>

function lookup(messages: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      messages
    )
}

/**
 * Every dynamic key the surface can build, as a flat list. Kept as one table
 * so a new enum member shows up as one missing row rather than as a silently
 * skipped family.
 */
const DYNAMIC_KEYS: string[] = [
  ...ISSUE_STATUSES.map((v) => `issues.status.${v}`),
  ...ISSUE_PRIORITIES.map((v) => `issues.priority.${v}`),
  ...ISSUE_SOURCE_KINDS.map((v) => `issues.source.${v}`),
  ...ISSUE_PROJECT_STATUSES.map((v) => `issues.projects.status.${v}`),
  // Keyed by `IssueRun.adapterId`, NOT by `kind` — the detail panel builds the
  // key from the adapter id, and the two are separate fields that only happen
  // to agree today.
  ...ADAPTER_IDS.flatMap((v) => [
    `issues.run.adapter.${v}.name`,
    `issues.run.adapter.${v}.description`,
  ]),
  ...ISSUE_RUN_STATUSES.map((v) => `issues.run.status.${v}`),
  ...RUN_REFUSALS.map((v) => `issues.run.refusal.${v}`),
  ...MOVE_DENIALS.map((v) => `issues.board.denied.${v}`),
  ...EVENT_KINDS.map((v) => `issues.activity.${v}`),
  ...DND_KEYS.map((v) => `issues.board.dnd.${v}`),
  ...ISSUE_GROUP_BY_OPTIONS.map((v) => `issues.toolbar.groupBy.${v}`),
  ...ISSUE_SORT_MODES.map((v) => `issues.toolbar.sort.${v}`),
  ...ISSUE_LIST_DENSITIES.map((v) => `issues.toolbar.density.${v}`),
  ...FILTER_FACET_KEYS.map((v) => `issues.toolbar.facet.${v}`),
  ...BUILTIN_ISSUE_VIEWS.map((view) => `issues.views.${view.labelKey}`),
  ...ACTOR_KEYS.map((v) => `issues.actor.${v}`),
  // The Agent Team board refuses drops with its own denial vocabulary.
  ...TASK_MOVE_DENIALS.map((v) => `agentTeamsWorkspace.tasks.board.denied.${v}`),
  // Section headings the property menus reuse for their own labels.
  ...["status", "priority", "assignee", "labels", "project"].map((v) => `issues.detail.${v}`),
]

describe("issue tracker dynamic message keys", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    describe(locale, () => {
      it.each(DYNAMIC_KEYS)("resolves %s", (key) => {
        const value = lookup(messages, key)
        expect(typeof value).toBe("string")
        expect(value).not.toBe("")
      })
    })
  }

  describe("the list itself stays derived", () => {
    it("covers every status the board can render", () => {
      expect(DYNAMIC_KEYS.filter((key) => key.startsWith("issues.status."))).toHaveLength(
        ISSUE_STATUSES.length
      )
    })

    it("keys the run adapters by adapterId, which is what the panel builds from", () => {
      // They agree today only because every adapter picked `id === kind`. If
      // one ever diverges, the messages must follow the id, not the kind.
      expect([...ADAPTER_IDS].sort()).toEqual([...ISSUE_RUN_KINDS].sort())
    })

    it("covers every event kind the activity trail can be handed", () => {
      expect(EVENT_KINDS).toHaveLength(18)
    })
  })
})
