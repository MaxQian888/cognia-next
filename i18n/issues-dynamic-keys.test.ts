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

import { ISSUE_GROUP_BY_OPTIONS } from "@/lib/issues/board-model"
import { ISSUE_LIST_DENSITIES, ISSUE_SORT_MODES, BUILTIN_ISSUE_VIEWS } from "@/lib/issues/views"
import {
  ISSUE_PRIORITIES,
  ISSUE_PROJECT_STATUSES,
  ISSUE_RUN_KINDS,
  ISSUE_RUN_STATUSES,
  ISSUE_STATUSES,
} from "@/types/issues"
import { ISSUE_SOURCE_KINDS } from "@/types/issues/unified"

/** The three reasons `canMoveIssue` can return. */
const MOVE_DENIALS = ["federated-read-only", "runtime-owned", "illegal-transition"] as const

/** Every `IssueRunRefusalReason`. */
const RUN_REFUSALS = [
  "assignee-kind-mismatch",
  "assignee-not-found",
  "team-busy",
  "no-github-ref",
  "no-github-repo",
  "desktop-only",
  "no-github-account",
  "run-active",
  "issue-finished",
  "adapter-missing",
] as const

/** Every `IssueEvent["kind"]`, which the activity trail renders one line for. */
const EVENT_KINDS = [
  "created",
  "status_changed",
  "assigned",
  "unassigned",
  "reassigned",
  "priority_changed",
  "label_added",
  "label_removed",
  "title_changed",
  "description_changed",
  "project_changed",
  "commented",
  "run_started",
  "run_succeeded",
  "run_failed",
  "artifact_linked",
  "github_linked",
  "github_write_back",
] as const

/** The screen-reader announcements the board builds at drag time. */
const DND_KEYS = ["instructions", "pickedUp", "over", "denied", "dropped", "cancelled"] as const

/** The facet names the filter chips localize. */
const FILTER_FACETS = ["query", "priority", "labels", "assignee", "source", "project"] as const

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
  // Each adapter carries a name AND a description; the run dialog renders both.
  ...ISSUE_RUN_KINDS.flatMap((v) => [
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
  ...FILTER_FACETS.map((v) => `issues.toolbar.facet.${v}`),
  ...BUILTIN_ISSUE_VIEWS.map((view) => `issues.views.${view.labelKey}`),
  // Actor kinds, plus the two sentinels the pickers render.
  ...["human", "agent", "team", "unassigned", "noLead"].map((v) => `issues.actor.${v}`),
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

  it("covers every status the board can render", () => {
    // A guard on the guard: if `ISSUE_STATUSES` grows, this list grows with it
    // because it is derived, and the per-key assertions above then fail loudly
    // instead of the UI printing the raw enum value.
    expect(DYNAMIC_KEYS.filter((key) => key.startsWith("issues.status."))).toHaveLength(
      ISSUE_STATUSES.length
    )
  })
})
