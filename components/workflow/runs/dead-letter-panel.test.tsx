/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { WorkflowRunRow } from "@/types/workflow/visual"

function makeRow(patch: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "run_1",
    workflowId: "wf",
    status: "failed",
    triggerKind: "trigger.manual",
    triggerPayload: { a: 1 },
    startedAt: 1,
    error: { message: "boom", nodeId: "n_fail" },
    lastCompletedStepId: "n_ok",
    replayCount: 2,
    workflowSnapshot: {
      id: "wf",
      schemaVersion: 2,
      name: "wf",
      createdAt: 0,
      updatedAt: 0,
      nodes: [],
      edges: [],
      settings: {} as never,
    } as never,
    ...patch,
  }
}

let currentRows: WorkflowRunRow[] = [makeRow()]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => currentRows,
}))

const acknowledgeRun = jest.fn(async (..._a: unknown[]) => undefined)
const markReplayed = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/workflows", () => ({
  listDeadLetters: jest.fn(async () => currentRows),
  acknowledgeRun: (...a: unknown[]) => acknowledgeRun(...a),
  markReplayed: (...a: unknown[]) => markReplayed(...a),
}))

const runWorkflow = jest.fn(async (..._a: unknown[]) => ({
  runId: "replay_1",
  status: "failed" as const,
}))
const runFromStep = jest.fn(async (..._a: unknown[]) => ({
  runId: "resume_1",
  status: "succeeded" as const,
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflow(...a),
}))
jest.mock("@/lib/workflow/runtime/run-from-step", () => ({
  runFromStep: (...a: unknown[]) => runFromStep(...a),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { DeadLetterPanel } from "./dead-letter-panel"

function wrap() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeadLetterPanel workflowId="wf" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  currentRows = [makeRow()]
})

describe("DeadLetterPanel", () => {
  it("lists failed runs with their error, step and replay badge", () => {
    wrap()
    expect(screen.getByTestId("dead-letter-panel")).toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByText(/n_fail/)).toBeInTheDocument()
    expect(screen.getByText(/replayed ×2/)).toBeInTheDocument()
  })

  it("resume re-runs from the failed step and links the replay", async () => {
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-resume-run_1"))
    await waitFor(() => expect(runFromStep).toHaveBeenCalledTimes(1))
    expect(runFromStep).toHaveBeenCalledWith(
      expect.objectContaining({ startStepId: "n_fail", seedFromRunId: "run_1" })
    )
    expect(markReplayed).toHaveBeenCalledWith("run_1", "resume_1")
  })

  it("replay starts a fresh run and links it", async () => {
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-replay-run_1"))
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1))
    expect(markReplayed).toHaveBeenCalledWith("run_1", "replay_1")
  })

  it("dismiss acknowledges the run", async () => {
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-dismiss-run_1"))
    await waitFor(() => expect(acknowledgeRun).toHaveBeenCalledWith("run_1"))
  })

  it("resume uses lastCompletedStepId when there's no failed nodeId", async () => {
    currentRows = [makeRow({ error: { message: "boom" }, lastCompletedStepId: "n_ok" })]
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-resume-run_1"))
    await waitFor(() => expect(runFromStep).toHaveBeenCalledTimes(1))
    expect(runFromStep).toHaveBeenCalledWith(expect.objectContaining({ startStepId: "n_ok" }))
  })

  it("resume falls back to a full replay when there's no step to resume from", async () => {
    currentRows = [makeRow({ error: undefined, lastCompletedStepId: undefined })]
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-resume-run_1"))
    await waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1))
    expect(runFromStep).not.toHaveBeenCalled()
  })

  it("renders a minimal failed run with no error object or replay history", () => {
    currentRows = [
      makeRow({ error: undefined, lastCompletedStepId: undefined, replayCount: undefined }),
    ]
    wrap()
    // Falls back to the generic "Run failed" label and shows no replay badge.
    expect(screen.getByText("Run failed")).toBeInTheDocument()
    expect(screen.queryByText(/replayed ×/)).toBeNull()
  })

  it("surfaces a resume failure as an error toast", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    runFromStep.mockRejectedValueOnce(new Error("nope"))
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-resume-run_1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"))
  })

  it("surfaces a replay failure as an error toast", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    runWorkflow.mockRejectedValueOnce(new Error("kaboom"))
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-replay-run_1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("kaboom"))
  })

  it("stringifies a non-Error rejection from resume", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    runFromStep.mockRejectedValueOnce("plain string")
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-resume-run_1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("plain string"))
  })

  it("stringifies a non-Error rejection from replay", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    runWorkflow.mockRejectedValueOnce(123)
    wrap()
    fireEvent.click(screen.getByTestId("dead-letter-replay-run_1"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("123"))
  })

  it("renders nothing when the queue is empty", () => {
    currentRows = []
    wrap()
    expect(screen.queryByTestId("dead-letter-panel")).toBeNull()
  })
})
