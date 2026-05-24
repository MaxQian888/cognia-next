/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"
import { WorkflowRuntimeProvider } from "./workflow-runtime-provider"

const installTriggerBridgeMock = jest.fn()
const listWorkflowsMock = jest.fn()
const syncWorkflowTriggersMock = jest.fn()
const resumeInFlightRunsMock = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  __esModule: true,
  installTriggerBridge: (...args: unknown[]) => installTriggerBridgeMock(...args),
}))

jest.mock("@/lib/db/workflows", () => ({
  __esModule: true,
  listWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
}))

jest.mock("@/lib/workflow/runtime/webhook-bridge", () => ({
  __esModule: true,
  syncWorkflowTriggers: (...args: unknown[]) => syncWorkflowTriggersMock(...args),
}))

jest.mock("@/lib/workflow/runtime/resume-controller", () => ({
  __esModule: true,
  resumeInFlightRuns: (...args: unknown[]) => resumeInFlightRunsMock(...args),
}))

beforeEach(() => {
  installTriggerBridgeMock.mockReset()
  listWorkflowsMock.mockReset()
  syncWorkflowTriggersMock.mockReset()
  resumeInFlightRunsMock.mockReset()
  // Default: nothing in-flight. Individual tests can override.
  resumeInFlightRunsMock.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 })
})

describe("WorkflowRuntimeProvider", () => {
  it("installs the trigger bridge and syncs every workflow on mount", async () => {
    const disposer = jest.fn()
    installTriggerBridgeMock.mockResolvedValue(disposer)
    listWorkflowsMock.mockResolvedValue([
      { id: "wf_a", nodes: [], edges: [] },
      { id: "wf_b", nodes: [], edges: [] },
    ])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)

    const { unmount } = render(
      <WorkflowRuntimeProvider>
        <div data-testid="child">ok</div>
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(installTriggerBridgeMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listWorkflowsMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(syncWorkflowTriggersMock).toHaveBeenCalledTimes(2))
    expect(syncWorkflowTriggersMock).toHaveBeenCalledWith(expect.objectContaining({ id: "wf_a" }))
    expect(syncWorkflowTriggersMock).toHaveBeenCalledWith(expect.objectContaining({ id: "wf_b" }))

    unmount()
    expect(disposer).toHaveBeenCalledTimes(1)
  })

  it("resumes in-flight runs on mount, after syncing triggers", async () => {
    const disposer = jest.fn()
    installTriggerBridgeMock.mockResolvedValue(disposer)
    listWorkflowsMock.mockResolvedValue([])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)
    resumeInFlightRunsMock.mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    })

    const { unmount } = render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(resumeInFlightRunsMock).toHaveBeenCalledTimes(1))
    // Resume must run after the initial trigger sync so a replayed run sees a
    // fully wired runtime.
    expect(listWorkflowsMock.mock.invocationCallOrder[0]).toBeLessThan(
      resumeInFlightRunsMock.mock.invocationCallOrder[0]
    )

    unmount()
  })

  it("survives a failing resume without crashing children", async () => {
    installTriggerBridgeMock.mockResolvedValue(jest.fn())
    listWorkflowsMock.mockResolvedValue([])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)
    resumeInFlightRunsMock.mockRejectedValue(new Error("mirror unavailable"))

    const { getByTestId } = render(
      <WorkflowRuntimeProvider>
        <div data-testid="child">ok</div>
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(resumeInFlightRunsMock).toHaveBeenCalled())
    expect(getByTestId("child")).toBeInTheDocument()
  })

  it("survives a failing installTriggerBridge without crashing children", async () => {
    installTriggerBridgeMock.mockRejectedValue(new Error("rust missing"))
    listWorkflowsMock.mockResolvedValue([])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)

    const { getByTestId } = render(
      <WorkflowRuntimeProvider>
        <div data-testid="child">ok</div>
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(installTriggerBridgeMock).toHaveBeenCalled())
    expect(getByTestId("child")).toBeInTheDocument()
  })

  it("calls the disposer even when the component unmounts before bridge resolves", async () => {
    const disposer = jest.fn()
    let resolveBridge!: (value: () => void) => void
    installTriggerBridgeMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveBridge = resolve
      })
    )
    listWorkflowsMock.mockResolvedValue([])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)

    const { unmount } = render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )

    unmount()
    resolveBridge(disposer)
    await waitFor(() => expect(disposer).toHaveBeenCalledTimes(1))
  })
})
