/**
 * Real desktop wiring for the Visual Workflow eval target. Loads the workflow
 * definition, drives `runWorkflow` with the case's `inputVars` as a manual
 * trigger payload, threading the run-scoped `traceId` so AI nodes emit their
 * LLM spans under it. Spans are read back by trace via `queryByTrace`.
 */

import { queryByTrace } from "@/lib/db/agent-traces"
import type { WorkflowTargetDeps } from "./workflow"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"
import Dexie from "dexie"

export function defaultWorkflowTargetDeps(scope?: EvalPersistenceScope): WorkflowTargetDeps {
  return {
    async runWorkflow({ workflowId, versionId, payload, traceId, signal }) {
      const assertActive = () => {
        scope?.assertActive()
        signal?.throwIfAborted()
      }
      assertActive()
      const [{ getWorkflow }, { getWorkflowVersion }, { runWorkflow }, { migrateWorkflow }] =
        await Promise.all([
          import("@/lib/db/workflows"),
          import("@/lib/db/workflow-deployments"),
          import("@/lib/workflow/runtime/orchestrator"),
          import("@/lib/workflow/definition/migrate"),
        ])
      assertActive()
      const version = versionId
        ? await (scope ? scope.db.workflowVersions.get(versionId) : getWorkflowVersion(versionId))
        : undefined
      assertActive()
      if (versionId && (!version || version.workflowId !== workflowId)) {
        throw new Error(
          `eval workflow target: version "${versionId}" does not belong to workflow "${workflowId}"`
        )
      }
      const definition =
        version?.definition ??
        (await (scope ? scope.db.workflows.get(workflowId) : getWorkflow(workflowId)))
      assertActive()
      const workflow = definition && scope && !version ? migrateWorkflow(definition) : definition
      if (!workflow) throw new Error(`eval workflow target: workflow "${workflowId}" not found`)
      const result = await runWorkflow({
        workflow,
        trigger: {
          workflowId,
          kind: "trigger.manual",
          payload,
          originAt: Date.now(),
        },
        traceId,
        ...(signal ? { signal } : {}),
      })
      assertActive()
      return {
        runId: result.runId,
        status: result.status,
        output: result.output,
        traceId,
      }
    },
    async fetchSpansByTrace(traceId: string) {
      scope?.assertActive()
      const spans = await (scope
        ? scope.db.agentTraces
            .where("[traceId+startTime]")
            .between([traceId, Dexie.minKey], [traceId, Dexie.maxKey])
            .toArray()
        : queryByTrace(traceId))
      scope?.assertActive()
      return spans
    },
  }
}
