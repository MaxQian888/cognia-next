/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { makeRun } from "@/lib/harness/test-fixtures"

const mockStart = jest.fn()
const mockPreview = jest.fn()
jest.mock("@/lib/harness/runtime/start", () => {
  const actual = jest.requireActual("@/lib/harness/runtime/start")
  return {
    ...actual,
    startHarnessRun: (...args: unknown[]) => mockStart(...args),
    previewHarnessRun: (...args: unknown[]) => mockPreview(...args),
    defaultStartDeps: async () => ({ deps: true }),
    defaultEstimateSingleRun: jest.fn(),
  }
})
const mockLaunch = jest.fn()
jest.mock("@/lib/harness/runtime/run-control", () => ({
  launchHarnessRun: (id: string) => mockLaunch(id),
}))
const mockPickPaths = jest.fn()
const mockPickDir = jest.fn()
jest.mock("@/lib/files/file-bridge", () => ({
  pickFilePaths: (...a: unknown[]) => mockPickPaths(...a),
  pickDirectory: () => mockPickDir(),
}))
let mockShell = true
jest.mock("@/hooks/use-host-profile", () => ({ useCapability: () => mockShell }))
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings: mockSettings }),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }))

import { toast } from "sonner"
import { HarnessStartRunDialog } from "./harness-start-run-dialog"

const agent = { id: "agent-1", name: "Analyst", providerId: "openai", model: "gpt-x" }

beforeEach(() => {
  jest.useFakeTimers()
  mockStart.mockReset().mockResolvedValue({ created: true, run: makeRun({ id: "run-9" }) })
  mockPreview.mockReset().mockResolvedValue({
    estimate: {
      work: { rollouts: 4, editorSessions: 3, judgeCalls: 2, candidates: 2 },
      costUsd: 2.5,
      tokens: 120_000,
      modelCalls: 5,
      wallTimeMs: 600_000,
      exceeds: ["maxCostUsd"],
    },
    confidence: "few",
    sampleCount: 3,
  })
  mockLaunch.mockReset().mockResolvedValue(undefined)
  mockShell = true
  mockSettings = { harnessEvolution: { enabled: true, startMode: "manual", defaultK: 1 } }
})
afterEach(() => jest.useRealTimers())

async function flushEstimate() {
  await act(async () => {
    jest.advanceTimersByTime(300)
  })
  await act(async () => {})
}

describe("HarnessStartRunDialog", () => {
  it("renders nothing while closed", () => {
    render(<HarnessStartRunDialog open={false} onOpenChange={jest.fn()} agent={agent} />)
    expect(screen.queryByTestId("harness-start-dialog")).not.toBeInTheDocument()
  })

  it("estimates before anything is spent and flags exceeded ceilings", async () => {
    render(<HarnessStartRunDialog open onOpenChange={jest.fn()} agent={agent} />)
    await flushEstimate()
    await waitFor(() =>
      expect(screen.getByTestId("harness-estimate")).toHaveTextContent("4 rollouts")
    )
    expect(screen.getByTestId("harness-estimate")).toHaveTextContent(
      "About $2.50 · 120.0K tokens · 10.0m"
    )
    expect(screen.getByTestId("harness-estimate")).toHaveTextContent(
      "Based on only 3 comparable runs"
    )
    expect(screen.getByText("Over the cost ceiling")).toBeInTheDocument()
    const [config, estimatedAgent] = mockPreview.mock.calls[0]
    expect(config).toMatchObject({ mode: "parallel", k: 1, scope: "task" })
    expect(estimatedAgent).toBe(agent)
  })

  it("starts a run from a failure's draft with the person's overrides, then launches it", async () => {
    const onStarted = jest.fn()
    const onOpenChange = jest.fn()
    render(
      <HarnessStartRunDialog
        open
        onOpenChange={onOpenChange}
        agent={agent}
        trigger="failure-triggered"
        sessionId="sess-1"
        projectId="proj-1"
        onStarted={onStarted}
        draft={{
          title: "Fix the parser",
          prompt: "Fix the CSV parser",
          isolation: "git",
          git: { sourceRoot: "/repo", projectId: "proj-1" },
          checks: [],
          source: { kind: "session", sessionId: "sess-1", messageId: "m1" },
        }}
      />
    )
    await flushEstimate()
    expect(screen.getByLabelText("Title")).toHaveValue("Fix the parser")
    expect(screen.getByLabelText("Repository")).toHaveValue("/repo")
    fireEvent.change(screen.getByLabelText("Where an improvement applies"), {
      target: { value: "session" },
    })
    fireEvent.change(screen.getByLabelText("Cost ceiling (USD)"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("Expected files"), {
      target: { value: "src/parser.ts\n\n" },
    })
    fireEvent.click(screen.getByLabelText("Scripts"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("harness-start-submit"))
    })
    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    const [input, deps] = mockStart.mock.calls[0]
    expect(deps).toEqual({ deps: true })
    expect(input).toMatchObject({
      characterId: "agent-1",
      trigger: "failure-triggered",
      sessionId: "sess-1",
      projectId: "proj-1",
      task: {
        title: "Fix the parser",
        isolation: "git",
        git: { sourceRoot: "/repo", baseRef: "HEAD", projectId: "proj-1" },
        expectedDeliverables: ["src/parser.ts"],
        source: { kind: "session", sessionId: "sess-1", messageId: "m1" },
      },
      overrides: { scope: "session", budget: { maxCostUsd: 2 }, networkOff: true },
    })
    expect(input.overrides.editable).not.toContain("scripts")
    expect(mockLaunch).toHaveBeenCalledWith("run-9")
    expect(onStarted).toHaveBeenCalledWith("run-9")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("opens an identical active run instead of starting another", async () => {
    mockStart.mockResolvedValue({ created: false, run: makeRun({ id: "run-1" }) })
    const onStarted = jest.fn()
    render(
      <HarnessStartRunDialog open onOpenChange={jest.fn()} agent={agent} onStarted={onStarted} />
    )
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } })
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Do the thing" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("harness-start-submit"))
    })
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("run-1"))
    expect(mockLaunch).not.toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalled()
  })

  it("adds picked input files to a scratch-directory task and validates before starting", async () => {
    mockPickPaths.mockResolvedValue(["/data/sales.csv"])
    render(<HarnessStartRunDialog open onOpenChange={jest.fn()} agent={agent} />)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Report" } })
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Summarise" } })
    fireEvent.change(screen.getByLabelText("Where each attempt works"), {
      target: { value: "files" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("harness-add-files"))
    })
    await waitFor(() =>
      expect(screen.getByLabelText("Path inside the task")).toHaveValue("sales.csv")
    )
    fireEvent.change(screen.getByLabelText("Path inside the task"), {
      target: { value: "../escape.csv" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("harness-start-submit"))
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The task is not ready.", expect.anything())
    )
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("explains refusals in the person's language and keeps file isolation off without a shell", async () => {
    mockShell = false
    mockStart.mockRejectedValue(
      Object.assign(new Error("x"), { name: "HarnessStartError", code: "model-unavailable" })
    )
    render(<HarnessStartRunDialog open onOpenChange={jest.fn()} agent={agent} />)
    expect(screen.getByRole("option", { name: "Git worktree" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } })
    fireEvent.change(screen.getByLabelText("Request"), { target: { value: "Do the thing" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("harness-start-submit"))
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not start the run.", {
        description: expect.stringMatching(/No model can be called/),
      })
    )
  })
})
