/**
 * @jest-environment jsdom
 *
 * Run-detail header coverage for the token/cost usage pill (aggregated from
 * step_usage events). The timeline/step-inspector internals have their own
 * suites; this exercises the live-query join + header rendering.
 */
import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { RunDetail } from "./run-detail"

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}))

const retryWorkflowRunMock = jest.fn(async (..._args: unknown[]) => ({
  runId: "run2",
  result: { runId: "run2", status: "succeeded" as const },
}))
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  __esModule: true,
  retryWorkflowRun: (...args: unknown[]) => retryWorkflowRunMock(...args),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  retryWorkflowRunMock.mockClear()
  routerPush.mockClear()
})

const snapshot: VisualWorkflow = {
  id: "wf1",
  schemaVersion: 1,
  name: "Usage workflow",
  createdAt: 0,
  updatedAt: 0,
  nodes: [
    {
      id: "n1",
      type: "ai.prompt",
      typeVersion: 2,
      position: { x: 0, y: 0 },
      data: { label: "Ask", params: { userPrompt: "hi" } },
    },
  ],
  edges: [],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
  },
}

function wrap() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunDetail workflowId="wf1" runId="run1" />
    </NextIntlClientProvider>
  )
}

describe("RunDetail", () => {
  it("shows the aggregated token + cost pill when steps reported usage", async () => {
    await getDb().workflowRuns.put({
      id: "run1",
      workflowId: "wf1",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 100,
      completedAt: 200,
      workflowSnapshot: snapshot,
      versionId: "version_1",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      executionBinding: {
        versionId: "version_1",
        deploymentId: "deployment_1",
        deploymentRevision: 1,
        entrypoint: "http",
        caller: "client:test",
      },
    })
    await getDb().workflowRunEvents.bulkPut([
      { id: "e1", runId: "run1", ts: 101, type: "step_started", stepId: "n1" },
      {
        id: "e2",
        runId: "run1",
        ts: 110,
        type: "step_usage",
        stepId: "n1",
        payload: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costUsd: 0.02 },
      },
      {
        id: "e3",
        runId: "run1",
        ts: 120,
        type: "step_completed",
        stepId: "n1",
        payload: { output: { completion: "x" } },
      },
    ])

    wrap()
    await waitFor(() => expect(screen.getByTestId("run-usage-pill")).toBeInTheDocument())
    expect(screen.getByTestId("run-usage-pill").textContent).toContain("1.5k tok")
    expect(screen.getByTestId("run-usage-pill").textContent).toContain("$0.020 est.")
  })

  it("omits the pill when no step reported usage", async () => {
    await getDb().workflowRuns.put({
      id: "run1",
      workflowId: "wf1",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 100,
      completedAt: 200,
      workflowSnapshot: snapshot,
      versionId: "version_1",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      executionBinding: {
        versionId: "version_1",
        deploymentId: "deployment_1",
        deploymentRevision: 1,
        entrypoint: "http",
        caller: "client:test",
      },
    })
    await getDb().workflowRunEvents.put({
      id: "e1",
      runId: "run1",
      ts: 120,
      type: "step_completed",
      stepId: "n1",
      payload: { output: {} },
    })

    wrap()
    await waitFor(() => expect(screen.getByText("Usage workflow")).toBeInTheDocument())
    expect(screen.queryByTestId("run-usage-pill")).toBeNull()
  })

  it("re-runs from the auto-selected step, seeding the displayed run's outputs", async () => {
    await getDb().workflowRuns.put({
      id: "run1",
      workflowId: "wf1",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: { greeting: "hi" },
      startedAt: 100,
      completedAt: 200,
      workflowSnapshot: snapshot,
      versionId: "version_1",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      executionBinding: {
        versionId: "version_1",
        deploymentId: "deployment_1",
        deploymentRevision: 1,
        entrypoint: "http",
        caller: "client:test",
      },
    })
    await getDb().workflowRunEvents.put({
      id: "e1",
      runId: "run1",
      ts: 120,
      type: "step_completed",
      stepId: "n1",
      payload: { output: { completion: "x" } },
    })

    wrap()
    const btn = await screen.findByTestId("run-detail-rerun-from-step")
    // Auto-pick selects the last step (n1) so the button is enabled.
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    await waitFor(() => expect(retryWorkflowRunMock).toHaveBeenCalledTimes(1))
    const arg = retryWorkflowRunMock.mock.calls[0][0] as Record<string, unknown>
    expect(arg).toEqual(
      expect.objectContaining({
        runId: "run1",
        mode: "failed-step",
        startStepId: "n1",
      })
    )
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(expect.stringContaining("run2")))
  })

  it("exposes original-version and current-production retries for formal runs", async () => {
    await getDb().workflowRuns.put({
      id: "run1",
      workflowId: "wf1",
      status: "failed",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 100,
      completedAt: 200,
      workflowSnapshot: snapshot,
      versionId: "version_1",
      deploymentId: "deployment_1",
      deploymentRevision: 3,
      executionBinding: {
        versionId: "version_1",
        deploymentId: "deployment_1",
        deploymentRevision: 3,
        entrypoint: "mcp",
        caller: "principal:alice",
      },
      traceId: "trace_1",
      lineage: { rootRunId: "run1" },
    })

    wrap()
    fireEvent.click(await screen.findByTestId("run-detail-rerun-original"))
    await waitFor(() =>
      expect(retryWorkflowRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run1", mode: "original-version" })
      )
    )
    expect(screen.getByTestId("run-provenance")).toHaveTextContent("entrypoint mcp")
    expect(screen.getByTestId("run-provenance")).toHaveTextContent("deployment revision 3")
  })

  it("renders the export button and the step breakdown table", async () => {
    await getDb().workflowRuns.put({
      id: "run1",
      workflowId: "wf1",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 100,
      completedAt: 200,
      workflowSnapshot: snapshot,
    })
    await getDb().workflowRunEvents.bulkPut([
      { id: "e1", runId: "run1", ts: 101, type: "step_started", stepId: "n1" },
      {
        id: "e2",
        runId: "run1",
        ts: 150,
        type: "step_completed",
        stepId: "n1",
        payload: { output: {} },
      },
    ])

    wrap()
    expect(await screen.findByTestId("run-detail-export")).toBeInTheDocument()
    // The breakdown table surfaces the step by its node label ("Ask").
    expect(await screen.findByTestId("breakdown-row-n1")).toHaveTextContent("Ask")
  })
})
