/**
 * `/workflow` controller — list, run, and inspect visual workflows by reusing
 * the desktop's `runWorkflow` orchestrator and the `lib/db/workflows` CRUD
 * verbatim against the CLI-local Dexie. Each function dispatches TuiActions;
 * the DB + runner seams are injected for tests.
 */
import { nanoid } from "nanoid"
import { getWorkflow, listWorkflows, listWorkflowRuns } from "@/lib/db/workflows"
import type { RunStatus, WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import {
  runWorkflow,
  type RunWorkflowInput,
  type RunWorkflowResult,
} from "@/lib/workflow/runtime/orchestrator"

import { ensureCliDb } from "../../db/bootstrap"
import { errorMessage } from "./shared"
import { buildRunsDocument, buildWorkflowDocument } from "./workflow-doc"
import { buildInitialSteps, type RunStepView } from "./workflow-run-fold"
import { startRunWatch, type RunWatchSubscribe } from "./workflow-run-watch"
import { buildRunTimeline } from "./workflow-run-timeline"
import type { TuiAction } from "../state/types"

export interface WorkflowDeps {
  dispatch: (action: TuiAction) => void
  signal?: AbortSignal
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<WorkflowRow[]>
  get?: (id: string) => Promise<WorkflowRow | undefined>
  run?: (input: RunWorkflowInput) => Promise<RunWorkflowResult>
  listRuns?: (query: { workflowId: string }) => Promise<WorkflowRunRow[]>
  /** Test seam for the live run-event subscription (defaults to liveQuery). */
  subscribe?: RunWatchSubscribe
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

  deps.dispatch({ type: "ACTIVITY_START", kind: "workflow", label: wf.name, max: initial.length })
  deps.dispatch({ type: "WORKFLOW_RUN_START", steps: initial })

  const watch = startRunWatch({
    runId,
    initial,
    ...(deps.subscribe ? { subscribe: deps.subscribe } : {}),
    onState: (s) => {
      lastSteps = s.steps
      const current = s.currentId ? s.steps.find((x) => x.id === s.currentId) : undefined
      deps.dispatch({
        type: "WORKFLOW_RUN_STEP",
        steps: s.steps,
        completed: s.completed,
        ...(s.currentId !== undefined ? { currentId: s.currentId } : {}),
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
    deps.dispatch({ type: "NOTICE", message: buildRunTimeline(wf, lastSteps, status) })
    deps.dispatch({ type: "ACTIVITY_END", status: status === "failed" ? "error" : "done" })
  }

  const runner = deps.run ?? runWorkflow
  try {
    const result = await runner({
      workflow: wf,
      runId,
      trigger: { workflowId: wf.id, kind: "trigger.manual", payload: {}, originAt: 0 },
      signal: deps.signal,
    } as RunWorkflowInput)
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
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: `Workflow · ${wf.name}`,
      body: buildWorkflowDocument(wf, runs),
      format: "markdown",
    },
  })
}

export async function workflowRuns(id: string, deps: WorkflowDeps): Promise<void> {
  await dbOf(deps)()
  const wf = await (deps.get ?? getWorkflow)(id)
  if (!wf) {
    deps.dispatch({ type: "NOTICE", message: `Workflow ${id} not found.` })
    return
  }
  const runs = await (deps.listRuns ?? listWorkflowRuns)({ workflowId: id })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "document",
      title: `Runs · ${wf.name}`,
      body: buildRunsDocument(wf, runs),
      format: "markdown",
    },
  })
}
