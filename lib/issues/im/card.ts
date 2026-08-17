/**
 * A2UI surfaces for the issue tracker's IM side (ADR-0130 slice ③).
 *
 * Two PURE builders, mirroring `lib/connectors/a2ui-bridge/workflow-to-a2ui.ts`:
 *
 *   1. `buildIssueCardSurface` — one issue as an interactive card: status,
 *      assignee, priority, and a Row of Buttons for every LEGAL human move
 *      (`lib/issues/state-machine.ts`), a Run button when the issue can be
 *      dispatched, and an "Open" link to the desktop board.
 *   2. `buildCreateIssueConfirmSurface` — the "file this as an issue?" card:
 *      the draft, then one Button per candidate project (the conversation's
 *      remembered project first) and Cancel. Nothing is written until a
 *      project button is pressed.
 *
 * Every Button carries `bindingKind: "issue_action"` + `bindingPayload`, the
 * platform-agnostic hint the mappers turn into an `issue_action` binding row
 * (`bindingHintFields` in `adapters/_shared/a2ui-mapper.ts`) so a click
 * reaches `lib/issues/im/callback-handler.ts` instead of a model digest turn.
 * The `widget.fallbackText` mirror lists numbered options for adapters with
 * no button support (the `numeric_action` path).
 *
 * Strings default to English and are overridable via `labels` — this runs in
 * the headless connector runtime where `next-intl` is unavailable, exactly
 * like the workflow and help surfaces.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { Issue, IssueActor, IssueProject, IssueStatus } from "@/types/issues"

/** What one issue-card button does. Persisted as the binding payload. */
export type IssueActionPayload =
  | { action: "move"; issueId: string; to: IssueStatus }
  | { action: "run"; issueId: string }
  | {
      action: "create"
      draft: IssueDraft
      issueProjectId: string
    }
  | { action: "cancel_create"; draftId: string }

/** The proposed issue on the confirmation card. */
export interface IssueDraft {
  /** Random id shared by every button of one confirmation card. */
  draftId: string
  title: string
  description?: string
  /** Platform message id the draft was quoted from, when any. */
  sourceMessageId?: string
}

export interface IssueCardLabels {
  status: string
  assignee: string
  priority: string
  unassigned: string
  moveTo: string
  run: string
  open: string
  runtimeOwned: string
  statuses: Record<IssueStatus, string>
  actors: Record<IssueActor["kind"], string>
}

export const DEFAULT_ISSUE_CARD_LABELS: IssueCardLabels = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  unassigned: "Unassigned",
  moveTo: "Move to",
  run: "▶ Run",
  open: "Open on the board",
  runtimeOwned: "A run is in progress — the runtime owns this issue until it finishes.",
  statuses: {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In progress",
    in_review: "In review",
    done: "Done",
    canceled: "Canceled",
  },
  actors: { human: "You", agent: "Agent", team: "Squad" },
}

export function actorDisplay(actor: IssueActor | undefined, labels: IssueCardLabels): string {
  if (!actor) return labels.unassigned
  return actor.label ?? labels.actors[actor.kind]
}

export interface IssueCardSurfaceInput {
  surfaceId: string
  issue: Pick<
    Issue,
    "id" | "identifier" | "title" | "description" | "status" | "priority" | "assignee"
  >
  project?: Pick<IssueProject, "name" | "key">
  /** Human-legal move targets, already filtered by the state machine. */
  moveTargets: readonly IssueStatus[]
  /** Whether the Run button should render (an engine can run it right now). */
  canRun: boolean
  /** True while a run is active — explains why no move buttons render. */
  runActive?: boolean
  /** Absolute or app-relative link to `/issues?id=…`. */
  openHref: string
  labels?: Partial<IssueCardLabels>
}

function issuePayloadHint(payload: IssueActionPayload) {
  return { bindingKind: "issue_action", bindingPayload: payload }
}

/** Build the interactive issue card. Pure. */
export function buildIssueCardSurface(input: IssueCardSurfaceInput): A2UISegmentContent {
  const labels: IssueCardLabels = { ...DEFAULT_ISSUE_CARD_LABELS, ...(input.labels ?? {}) }
  const { issue } = input
  const title = `${issue.identifier} ${issue.title}`
  const metaText = [
    `${labels.status}: ${labels.statuses[issue.status]}`,
    `${labels.assignee}: ${actorDisplay(issue.assignee, labels)}`,
    `${labels.priority}: ${issue.priority}`,
    ...(input.project ? [`${input.project.key} · ${input.project.name}`] : []),
  ].join(" · ")
  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: [] as string[] },
    meta: { component: "Text", text: metaText },
  }
  const children: string[] = ["meta"]
  if (issue.description) {
    components.description = { component: "Text", text: issue.description.slice(0, 500) }
    children.push("description")
  }

  const mirror: string[] = [`# ${title}`, metaText]
  if (issue.description) mirror.push(issue.description.slice(0, 500))

  const actionIds: string[] = []
  let numeric = 1
  if (input.runActive) {
    components.runtimeOwned = { component: "Text", text: labels.runtimeOwned }
    children.push("runtimeOwned")
    mirror.push(labels.runtimeOwned)
  }
  for (const to of input.moveTargets) {
    const id = `move_${to}`
    components[id] = {
      component: "Button",
      text: `${labels.moveTo} ${labels.statuses[to]}`,
      action: `move:${to}`,
      ...issuePayloadHint({ action: "move", issueId: issue.id, to }),
    }
    actionIds.push(id)
    mirror.push(`${numeric++}. ${labels.moveTo} ${labels.statuses[to]}`)
  }
  if (input.canRun) {
    components.run = {
      component: "Button",
      text: labels.run,
      action: "run",
      variant: "primary",
      ...issuePayloadHint({ action: "run", issueId: issue.id }),
    }
    actionIds.push("run")
    mirror.push(`${numeric++}. ${labels.run}`)
  }
  if (actionIds.length > 0) {
    components.actions = { component: "Row", children: actionIds }
    children.push("actions")
  }
  components.open = { component: "Link", text: labels.open, href: input.openHref, external: true }
  children.push("open")
  mirror.push(`${labels.open}: ${input.openHref}`)
  ;(components.root as { children: string[] }).children = children

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirror.filter(Boolean).join("\n") },
  }
}

export interface CreateIssueConfirmLabels {
  title: string
  summary: string
  createIn: string
  cancel: string
  hint: string
}

export const DEFAULT_CREATE_ISSUE_CONFIRM_LABELS: CreateIssueConfirmLabels = {
  title: "File as an issue?",
  summary: "Nothing is saved until you pick a project.",
  createIn: "Create in",
  cancel: "Cancel",
  hint: "Reply with a number to choose",
}

export interface CreateIssueConfirmSurfaceInput {
  surfaceId: string
  draft: IssueDraft
  /** Candidate containers, most recently used first; capped at five by the caller. */
  projects: ReadonlyArray<Pick<IssueProject, "id" | "name" | "key">>
  /** The conversation's remembered project — rendered first and highlighted. */
  defaultProjectId?: string
  labels?: Partial<CreateIssueConfirmLabels>
}

/** Build the create-issue confirmation card. Pure. */
export function buildCreateIssueConfirmSurface(
  input: CreateIssueConfirmSurfaceInput
): A2UISegmentContent {
  const labels = { ...DEFAULT_CREATE_ISSUE_CONFIRM_LABELS, ...(input.labels ?? {}) }
  const ordered = [...input.projects].sort((a, b) => {
    if (a.id === input.defaultProjectId) return -1
    if (b.id === input.defaultProjectId) return 1
    return 0
  })
  const components: Record<string, unknown> = {
    root: { component: "Card", title: labels.title, children: [] as string[] },
    draftTitle: { component: "Text", text: `**${input.draft.title}**` },
    summary: { component: "Text", text: labels.summary },
  }
  const children = ["draftTitle"]
  const mirror = [`# ${labels.title}`, input.draft.title]
  if (input.draft.description) {
    components.draftBody = { component: "Text", text: input.draft.description.slice(0, 500) }
    children.push("draftBody")
    mirror.push(input.draft.description.slice(0, 500))
  }
  children.push("summary")
  mirror.push(labels.summary)

  const buttonIds: string[] = []
  ordered.forEach((project, index) => {
    const id = `project_${project.id}`
    components[id] = {
      component: "Button",
      text: `${labels.createIn} ${project.key}`,
      action: `create:${project.id}`,
      ...(project.id === input.defaultProjectId ? { variant: "primary" } : {}),
      ...issuePayloadHint({ action: "create", draft: input.draft, issueProjectId: project.id }),
    }
    buttonIds.push(id)
    mirror.push(`${index + 1}. ${labels.createIn} ${project.key} · ${project.name}`)
  })
  components.cancel = {
    component: "Button",
    text: labels.cancel,
    action: "cancel",
    ...issuePayloadHint({ action: "cancel_create", draftId: input.draft.draftId }),
  }
  buttonIds.push("cancel")
  mirror.push(`${ordered.length + 1}. ${labels.cancel}`, labels.hint)
  components.actions = { component: "Row", children: buttonIds }
  children.push("actions")
  ;(components.root as { children: string[] }).children = children

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title: labels.title,
    widget: { fallbackText: mirror.join("\n") },
  }
}
