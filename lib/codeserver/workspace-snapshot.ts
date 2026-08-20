/**
 * Project the user's work into what the Pro IDE's Cognia panel shows
 * (ADR-0088 Phase 3).
 *
 * Every decision lives here, on the app side: which items are worth showing,
 * how they are ordered, which codicon each gets, what the status bar says, and
 * whether anything deserves attention. The companion extension receives a flat,
 * already-localized, already-sorted snapshot and renders it verbatim.
 *
 * The split is not fussiness. The extension runs in a separate process, on a
 * pinned VS Code API, side-loaded at a version the app may not have shipped
 * with; anything it decides for itself is a second implementation of the app's
 * rules that upgrades independently of them. Rendering can look wrong. Deciding
 * can be wrong — and a panel that quietly disagrees with Cognia about which
 * issues are open is worse than no panel.
 *
 * Pure and dependency-free so the projection is testable without a database, a
 * running editor, or a translator.
 */

import type {
  CodeServerWorkspaceGroup,
  CodeServerWorkspaceRow,
  CodeServerWorkspaceSnapshot,
} from "./client"

/** How many rows one group may carry. */
export const WORKSPACE_GROUP_ROW_LIMIT = 20

/** The subset of an issue the panel needs. */
export interface WorkspaceIssueInput {
  id: string
  identifier: string
  title: string
  /** `started` issues sort first — they are what the user is doing now. */
  statusCategory: "backlog" | "unstarted" | "started" | "completed" | "canceled"
  status: string
  updatedAt: number
  /** Set when the issue text names a file, so the row can open it directly. */
  path?: string
  line?: number
}

/** The subset of a plan the panel needs. */
export interface WorkspacePlanInput {
  id: string
  title: string
  status: string
  /** Completed / total, rendered as the row's description. */
  completedSteps: number
  totalSteps: number
  updatedAt: number
}

/** The subset of an agent run the panel needs. */
export interface WorkspaceRunInput {
  id: string
  label: string
  status: string
  startedAt: number
}

/** Localized text the app supplies; the extension translates nothing. */
export interface WorkspaceSnapshotStrings {
  issuesTitle: string
  plansTitle: string
  runsTitle: string
  issuesEmpty: string
  plansEmpty: string
  runsEmpty: string
  /** `{count}` is substituted with the open-issue count. */
  statusText: string
  statusTooltip: string
  disconnected: string
  noCustomActions: string
  chooseAction: string
  noDiagnostics: string
}

export interface WorkspaceSnapshotInput {
  issues: WorkspaceIssueInput[]
  plans: WorkspacePlanInput[]
  runs: WorkspaceRunInput[]
  strings: WorkspaceSnapshotStrings
}

/** Codicon for an issue, keyed on the category the board already computes. */
function issueIcon(category: WorkspaceIssueInput["statusCategory"]): string {
  switch (category) {
    case "started":
      return "issue-reopened"
    case "completed":
      return "issue-closed"
    case "canceled":
      return "circle-slash"
    default:
      return "issue-opened"
  }
}

function planIcon(status: string): string {
  switch (status) {
    case "executing":
      return "sync"
    case "paused":
      return "debug-pause"
    case "failed":
      return "error"
    case "completed":
      return "pass"
    default:
      return "checklist"
  }
}

/** Open issues, most recently touched first, with started ones lifted to the top. */
function issueRows(issues: WorkspaceIssueInput[]): CodeServerWorkspaceRow[] {
  // Finished work is not what a panel glanced at mid-task is for; the board is
  // where history lives.
  const open = issues.filter(
    (issue) => issue.statusCategory !== "completed" && issue.statusCategory !== "canceled"
  )
  const ordered = [...open].sort((a, b) => {
    const aStarted = a.statusCategory === "started" ? 0 : 1
    const bStarted = b.statusCategory === "started" ? 0 : 1
    if (aStarted !== bStarted) return aStarted - bStarted
    return b.updatedAt - a.updatedAt
  })
  return ordered.slice(0, WORKSPACE_GROUP_ROW_LIMIT).map((issue) => ({
    id: `issue:${issue.id}`,
    label: `${issue.identifier} ${issue.title}`.trim(),
    description: issue.status,
    icon: issueIcon(issue.statusCategory),
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.line !== undefined ? { line: issue.line } : {}),
  }))
}

/** Live plans only — a finished plan is a record, not a thing to glance at. */
function planRows(plans: WorkspacePlanInput[]): CodeServerWorkspaceRow[] {
  const live = plans.filter(
    (plan) =>
      plan.status !== "completed" && plan.status !== "cancelled" && plan.status !== "canceled"
  )
  return [...live]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, WORKSPACE_GROUP_ROW_LIMIT)
    .map((plan) => ({
      id: `plan:${plan.id}`,
      label: plan.title,
      description: `${plan.completedSteps}/${plan.totalSteps} · ${plan.status}`,
      icon: planIcon(plan.status),
    }))
}

/** Newest run first: the one you just started is the one you are watching. */
function runRows(runs: WorkspaceRunInput[]): CodeServerWorkspaceRow[] {
  return [...runs]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, WORKSPACE_GROUP_ROW_LIMIT)
    .map((run) => ({
      id: `run:${run.id}`,
      label: run.label,
      description: run.status,
      icon: run.status === "failed" ? "error" : "play-circle",
    }))
}

/**
 * Build the snapshot.
 *
 * `attention` tints the status bar and is set only by a *failed* plan or run —
 * not by issue counts. A backlog is a normal condition, and a status bar that is
 * permanently orange is a status bar nobody reads.
 */
export function buildWorkspaceSnapshot(input: WorkspaceSnapshotInput): CodeServerWorkspaceSnapshot {
  const { strings } = input
  const issues = issueRows(input.issues)
  const plans = planRows(input.plans)
  const runs = runRows(input.runs)

  const groups: CodeServerWorkspaceGroup[] = [
    { id: "issues", title: strings.issuesTitle, rows: issues, emptyText: strings.issuesEmpty },
    { id: "plans", title: strings.plansTitle, rows: plans, emptyText: strings.plansEmpty },
    { id: "runs", title: strings.runsTitle, rows: runs, emptyText: strings.runsEmpty },
  ]

  const attention =
    input.plans.some((plan) => plan.status === "failed") ||
    input.runs.some((run) => run.status === "failed")

  return {
    statusText: strings.statusText.replace("{count}", String(issues.length)),
    statusTooltip: strings.statusTooltip,
    attention,
    groups,
  }
}
