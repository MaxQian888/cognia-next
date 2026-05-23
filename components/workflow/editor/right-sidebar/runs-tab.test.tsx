/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow, WorkflowRunRow } from "@/types/workflow/visual"

// Mock the heavy run sub-components (tested in their own suites). The timeline
// stub exposes a button that selects a step so we can drive the detail flow.
jest.mock("@/components/workflow/runs/run-status-pill", () => ({
  RunStatusPill: ({ status }: { status: string }) => (
    <span data-testid="status-pill">{status}</span>
  ),
}))
jest.mock("@/components/workflow/runs/run-timeline", () => ({
  RunTimeline: ({ onSelectStep }: { onSelectStep: (id: string) => void }) => (
    <button type="button" data-testid="timeline-select" onClick={() => onSelectStep("n_step")}>
      timeline
    </button>
  ),
}))
jest.mock("@/components/workflow/runs/run-step-detail", () => ({
  RunStepDetail: ({ stepId }: { stepId: string | null }) => (
    <div data-testid="step-detail">{stepId ?? "none"}</div>
  ),
}))

import { RunsTab } from "./runs-tab"

const messages = {
  workflowEditor: {
    runs: {
      empty: "No runs yet.",
      backToList: "Back to runs",
      revealOnCanvas: "Reveal on canvas",
      notFound: "Run not found.",
    },
  },
}

function workflow(): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "WF",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n_step",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Step", params: {} },
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
}

function runRow(): WorkflowRunRow {
  return {
    id: "run_1",
    workflowId: "wf",
    status: "succeeded",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1000,
    completedAt: 2000,
    workflowSnapshot: workflow(),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
})

function mount(reactFlowInstance?: unknown) {
  const store = createEditorStore(workflow())
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <RunsTab useStore={store} workflowId="wf" reactFlowInstance={reactFlowInstance as never} />
    </NextIntlClientProvider>
  )
  return store
}

describe("RunsTab", () => {
  it("shows the empty state when there are no runs", async () => {
    mount()
    expect(await screen.findByText(/No runs yet/, {}, { timeout: 4000 })).toBeInTheDocument()
  })

  it("navigates from the run list into the detail view and back", async () => {
    await getDb().workflowRuns.put(runRow())
    mount()
    const row = await screen.findByTestId("runs-tab-row-run_1")
    fireEvent.click(row)
    expect(await screen.findByTestId("runs-tab-detail")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Back to runs"))
    await waitFor(() => expect(screen.getByTestId("runs-tab")).toBeInTheDocument())
  })

  it("reveals the selected step on the canvas", async () => {
    await getDb().workflowRuns.put(runRow())
    const setViewport = jest.fn()
    const store = mount({ setViewport })
    fireEvent.click(await screen.findByTestId("runs-tab-row-run_1"))
    // Select a step via the timeline stub, then reveal it.
    fireEvent.click(await screen.findByTestId("timeline-select"))
    const reveal = await screen.findByTestId("runs-tab-reveal")
    act(() => {
      fireEvent.click(reveal)
    })
    expect(store.getState().selectedNodeIds).toEqual(["n_step"])
    expect(setViewport).toHaveBeenCalled()
  })
})
