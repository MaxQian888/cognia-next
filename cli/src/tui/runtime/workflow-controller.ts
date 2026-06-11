/**
 * `/workflow` controller — list, run, and inspect visual workflows by reusing
 * the desktop's `runWorkflow` orchestrator and the `lib/db/workflows` CRUD
 * verbatim against the CLI-local Dexie. Each function dispatches TuiActions;
 * the DB + runner seams are injected for tests.
 */
import { getWorkflow, listWorkflows, listWorkflowRuns } from "@/lib/db/workflows"
import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"
import {
  runWorkflow,
  type RunWorkflowInput,
  type RunWorkflowResult,
} from "@/lib/workflow/runtime/orchestrator"

import { ensureCliDb } from "../../db/bootstrap"
import { errorMessage } from "./shared"
import { buildRunsDocument, buildWorkflowDocument } from "./workflow-doc"
import type { TuiAction } from "../state/types"

export interface WorkflowDeps {
  dispatch: (action: TuiAction) => void
  signal?: AbortSignal
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<WorkflowRow[]>
  get?: (id: string) => Promise<WorkflowRow | undefined>
  run?: (input: RunWorkflowInput) => Promise<RunWorkflowResult>
  listRuns?: (query: { workflowId: string }) => Promise<WorkflowRunRow[]>
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
  deps.dispatch({ type: "ACTIVITY_START", kind: "workflow", label: wf.name })
  const runner = deps.run ?? runWorkflow
  try {
    const result = await runner({
      workflow: wf,
      trigger: { workflowId: wf.id, kind: "trigger.manual", payload: {}, originAt: 0 },
      signal: deps.signal,
    } as RunWorkflowInput)
    if (result.status === "failed") {
      const node = result.error?.nodeId ? ` (node ${result.error.nodeId})` : ""
      deps.dispatch({
        type: "ACTIVITY_END",
        status: "error",
        summary: `Workflow "${wf.name}" failed: ${result.error?.message ?? "unknown error"}${node}`,
      })
    } else {
      deps.dispatch({
        type: "ACTIVITY_END",
        status: "done",
        summary: `Workflow "${wf.name}" ${result.status}.`,
      })
    }
  } catch (err) {
    deps.dispatch({
      type: "ACTIVITY_END",
      status: "error",
      summary: `Workflow "${wf.name}" crashed: ${errorMessage(err)}`,
    })
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
