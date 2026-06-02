/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { DataTabs } from "./data-tabs"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeStore(): EditorStore {
  const wf: VisualWorkflow = {
    id: "wf_x",
    schemaVersion: 1,
    name: "t",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "n_a",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Alpha", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Beta", params: {} },
      },
    ],
    edges: [{ id: "e1", source: "n_a", target: "n_b" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
  return createEditorStore(wf)
}

function renderTabs(useStore: EditorStore, nodeId: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DataTabs useStore={useStore} nodeId={nodeId}>
        <div data-testid="config-content">config form</div>
      </DataTabs>
    </NextIntlClientProvider>
  )
}

describe("DataTabs", () => {
  it("shows the Config tab content by default", () => {
    renderTabs(makeStore(), "n_b")
    expect(screen.getByTestId("config-content")).toBeInTheDocument()
  })

  it("Output tab shows the empty state and Run-this-step triggers the store signal", async () => {
    const useStore = makeStore()
    renderTabs(useStore, "n_b")
    fireEvent.click(screen.getByRole("radio", { name: "Output" }))
    await waitFor(() => expect(screen.getByTestId("data-panel-empty")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Run this step" }))
    expect(useStore.getState().requestedRunSingleStepId).toBe("n_b")
  })

  it("Input tab lists upstream node sections", () => {
    renderTabs(makeStore(), "n_b")
    fireEvent.click(screen.getByRole("radio", { name: "Input" }))
    expect(screen.getByText("From Alpha")).toBeInTheDocument()
  })

  it("Input tab shows a no-inputs message for a node with no upstream", () => {
    renderTabs(makeStore(), "n_a")
    fireEvent.click(screen.getByRole("radio", { name: "Input" }))
    expect(screen.getByTestId("no-inputs")).toBeInTheDocument()
  })

  it("Output tab pins and unpins via the store when run data exists", async () => {
    // Seed a succeeded run whose n_b step produced output.
    await getDb().workflowRuns.put({
      id: "run_1",
      workflowId: "wf_x",
      status: "succeeded",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 10,
      workflowSnapshot: {} as VisualWorkflow,
    })
    await getDb().workflowRunEvents.put({
      id: "evt_1",
      runId: "run_1",
      ts: 11,
      type: "step_completed",
      stepId: "n_b",
      payload: { output: { completion: "hi" } },
    })

    const useStore = makeStore()
    renderTabs(useStore, "n_b")
    fireEvent.click(screen.getByRole("radio", { name: "Output" }))

    // Wait for the live query to surface the run output (data panel, not empty).
    await waitFor(() => expect(screen.getByTestId("data-panel")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Pin output" }))
    expect(useStore.getState().baseWorkflow.pinData).toEqual({ n_b: { completion: "hi" } })

    // Now pinned → Unpin appears.
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin" })).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }))
    expect(useStore.getState().baseWorkflow.pinData).toEqual({})
  })
})
