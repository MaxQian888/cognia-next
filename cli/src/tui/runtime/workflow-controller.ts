/**
 * `/workflow` controller — list, run, and inspect visual workflows by reusing
 * the desktop's Execution Authority and the `lib/db/workflows` CRUD against
 * the CLI-local Dexie. Formal CLI runs therefore require an active production
 * deployment; the DB + authority seams are injected for tests.
 */
import { nanoid } from "nanoid"
import { getWorkflow, getWorkflowRun, listWorkflows, listWorkflowRuns } from "@/lib/db/workflows"
import { listRunEvents } from "@/lib/workflow/runtime/event-log"
import type {
  RunStatus,
  WorkflowRow,
  WorkflowRunEventRow,
  WorkflowRunRow,
} from "@/types/workflow/visual"
import type { RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import {
  executeDeployedWorkflow,
  type ExecuteDeployedWorkflowInput,
} from "@/lib/workflow/runtime/execution-authority"

import { ensureCliDb } from "../../db/bootstrap"
import { errorMessage } from "./shared"
import { buildWorkflowDocument, formatRunDuration, runStatusIcon } from "./workflow-doc"
import {
  buildInitialSteps,
  foldRunEvents,
  type RunStepView,
  type RunUsageTotals,
} from "./workflow-run-fold"
import { startRunWatch, type RunWatchSubscribe } from "./workflow-run-watch"
import { startRunsWatch, type RunsWatchSubscribe } from "./workflow-runs-watch"
import { buildRunTimeline } from "./workflow-run-timeline"
import { buildRunReplayDoc } from "./workflow-replay-doc"
import type { TuiAction } from "../state/types"

export interface WorkflowDeps {
  dispatch: (action: TuiAction) => void
  signal?: AbortSignal
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<WorkflowRow[]>
  get?: (id: string) => Promise<WorkflowRow | undefined>
  run?: (input: ExecuteDeployedWorkflowInput) => Promise<RunWorkflowResult>
  listRuns?: (query: { workflowId: string }) => Promise<WorkflowRunRow[]>
  /** Fetch a single run row by id (for `/workflow replay`). */
  getRun?: (runId: string) => Promise<WorkflowRunRow | undefined>
  /** Fetch a run's persisted events (for `/workflow replay`). */
  listEvents?: (runId: string) => Promise<WorkflowRunEventRow[]>
  /** Test seam for the live run-event subscription (defaults to liveQuery). */
  subscribe?: RunWatchSubscribe
  /** Test seam for the live run-LIST subscription used by `/workflow inspect`. */
  subscribeRuns?: RunsWatchSubscribe
}

/** `<ISO date> · <duration>` label for a run-history select row. */
function runLabel(r: WorkflowRunRow): string {
  const dur =
    r.completedAt && r.startedAt ? formatRunDuration(r.completedAt - r.startedAt) : "in flight"
  const when = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 19)
  return `${when} · ${dur}`
}

const dbOf = (d: WorkflowDeps) => d.ensureDb ?? (() => ensureCliDb())

export async function workflowList(deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const rows = await (deps.list ?? listWorkflows)()
  if (rows.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No workflows found." })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Run workflow",
      items: rows.map((r) => ({ id: r.id, label: r.name, hint: r.description })),
      index: 0,
      onSelectCommand: "workflow run",
    },
  })
}

export async function workflowRun(id: string, deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const wf = await (deps.get ?? getWorkflow)(id)
  if (!wf) {
    deps.dispatch({ type: "NOTICE", message: `Workflow ${id} not found.` })
    return
  }

  // Generate the run id up front so the live watcher can subscribe to this run's
  // events while the orchestrator is still executing it (the orchestrator
  // accepts a caller-supplied runId and upserts the run row).
  const runId = "run_" + nanoid(12)
  const initial = buildInitialSteps(wf.nodes ?? [])
  let lastSteps: RunStepView[] = initial
  let lastUsage: RunUsageTotals | undefined

  deps.dispatch({ type: "ACTIVITY_START", kind: "workflow", label: wf.name, max: initial.length })
  deps.dispatch({ type: "WORKFLOW_RUN_START", steps: initial })

  const watch = startRunWatch({
    runId,
    initial,
    ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
    onState: (s, events) => {
      lastSteps = s.steps
      lastUsage = s.usage
      const current = s.currentId ? s.steps.find((x) => x.id === s.currentId) : undefined
      deps.dispatch({
        type: "WORKFLOW_RUN_STEP",
        steps: s.steps,
        completed: s.completed,
        ...(s.currentId !== undefined ? { currentId: s.currentId } : {}),
        ...(s.usage !== undefined ? { usage: s.usage } : {}),
        events,
      })
      deps.dispatch({
        type: "ACTIVITY_PROGRESS",
        turns: s.completed,
        ...(current ? { note: current.label } : {}),
      })
    },
  })

  // Commit the closing timeline cell + clear the panel. Shared by the success,
  // failure, and crash paths so the watcher subscription can never leak.
  const finish = (status: RunStatus): void => {
    watch.stop()
    deps.dispatch({ type: "WORKFLOW_RUN_END" })
    deps.dispatch({ type: "NOTICE", message: buildRunTimeline(wf, lastSteps, status, lastUsage) })
    deps.dispatch({ type: "ACTIVITY_END", status: status === "failed" ? "error" : "done" })
  }

  const runner =
    deps.run ??
    (async (input: ExecuteDeployedWorkflowInput) => (await executeDeployedWorkflow(input)).result)
  try {
    const result = await runner({
      workflowId: wf.id,
      entrypoint: "cli",
      caller: "cognia-cli",
      triggerKind: "trigger.manual",
      triggerOriginAt: Date.now(),
      payload: {},
      requestedRunId: runId,
      triggeredBy: { source: "api" },
      signal: deps.signal,
    })
    // Reflect an orchestrator-reported node failure the live fold may have
    // missed (e.g. a fast run where liveQuery never emitted).
    if (result.status === "failed" && result.error?.nodeId) {
      const nodeId = result.error.nodeId
      lastSteps = lastSteps.map((s) =>
        s.id === nodeId ? { ...s, status: "failed", error: result.error?.message } : s
      )
    }
    finish(result.status)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Workflow "${wf.name}" crashed: ${errorMessage(err)}`,
    })
    finish("failed")
  }
}

export async function workflowInspect(id: string, deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const wf = await (deps.get ?? getWorkflow)(id)
  if (!wf) {
    deps.dispatch({ type: "NOTICE", message: `Workflow ${id} not found.` })
    return
  }
  const runs = await (deps.listRuns ?? listWorkflowRuns)({ workflowId: id })
  const title = `Workflow · ${wf.name}`
  const open = (rows: WorkflowRunRow[]): void => {
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "document",
        title,
        body: buildWorkflowDocument(wf, rows),
        format: "markdown",
      },
    })
  }
  // First paint is instant + static (keeps the existing test valid).
  open(runs)

  // Then keep the overlay live: re-render whenever the run list changes. The
  // reducer replaces only the body for a same-title document, so the pager stays
  // mounted. Teardown rides the runtime abort signal (Esc/cancel) so we add no
  // App.tsx wiring and never leak the subscription.
  if (deps.signal?.aborted) return
  const watch = startRunsWatch({
    workflowId: id,
    ...(deps.subscribeRuns ? { subscribe: deps.subscribeRuns } : {}),
    onRuns: open,
  })
  deps.signal?.addEventListener("abort", () => watch.stop(), { once: true })
}

export async function workflowRuns(id: string, deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const wf = await (deps.get ?? getWorkflow)(id)
  if (!wf) {
    deps.dispatch({ type: "NOTICE", message: `Workflow ${id} not found.` })
    return
  }
  const runs = await (deps.listRuns ?? listWorkflowRuns)({ workflowId: id })
  if (runs.length === 0) {
    deps.dispatch({ type: "NOTICE", message: `No runs yet for "${wf.name}".` })
    return
  }
  // A selectable history: pick a run to replay it into a full inspector document.
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: `Runs · ${wf.name}`,
      items: runs.map((r) => ({
        id: r.id,
        label: `${runStatusIcon(r.status)} ${runLabel(r)}`,
        ...(r.error?.message ? { hint: r.error.message } : {}),
      })),
      index: 0,
      onSelectCommand: "workflow replay",
    },
  })
}

/**
 * Replay a finished run into a scrollable inspector document: its step timeline,
 * graph topology, and per-step detail — all rebuilt from the run's frozen
 * snapshot + persisted event log (reusing `foldRunEvents` + the doc builders).
 */
export async function workflowReplay(runId: string, deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const run = await (deps.getRun ?? getWorkflowRun)(runId)
  if (!run) {
    deps.dispatch({ type: "NOTICE", message: `Run ${runId} not found.` })
    return
  }
  const events = await (deps.listEvents ?? listRunEvents)(runId)
  const snapNodes = run.workflowSnapshot.nodes ?? []
  const folded = foldRunEvents(buildInitialSteps(snapNodes), events)
  const body = buildRunReplayDoc({
    workflowName: run.workflowSnapshot.name,
    status: run.status,
    steps: folded.steps,
    events,
    nodes: snapNodes.map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.data?.label ? { data: { label: n.data.label } } : {}),
    })),
    edges: (run.workflowSnapshot.edges ?? []).map((e) => ({ source: e.source, target: e.target })),
    ...(folded.usage ? { usage: folded.usage } : {}),
  })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: `Replay · ${run.workflowSnapshot.name}`,
      body,
      format: "markdown",
    },
  })
}
