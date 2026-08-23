/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { render, waitFor } from "@testing-library/react"
import { WorkflowRuntimeProvider } from "./workflow-runtime-provider"

const installTriggerBridgeMock = jest.fn()
const listWorkflowsMock = jest.fn()
const resolveWorkflowDeploymentMock = jest.fn()
const syncWorkflowTriggersMock = jest.fn()
const unsyncWorkflowTriggersMock = jest.fn()
const resumeInFlightRunsMock = jest.fn()
const initPluginTriggerLifecycleMock = jest.fn()
const disposePluginTriggerLifecycleMock = jest.fn(async () => undefined)
const registerScheduleHandoffDeliveryMock = jest.fn()
const installHostDispatchRuntimeMock = jest.fn()
const stopHostDispatchRuntimeMock = jest.fn(async () => undefined)

jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  __esModule: true,
  installTriggerBridge: (...args: unknown[]) => installTriggerBridgeMock(...args),
}))

jest.mock("@/lib/workflow/runtime/schedule-handoff-delivery", () => ({
  registerScheduleHandoffDelivery: () => registerScheduleHandoffDeliveryMock(),
}))

jest.mock("@/lib/placement/host-dispatch-runtime", () => ({
  installHostDispatchRuntime: (...args: unknown[]) => installHostDispatchRuntimeMock(...args),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "account-1",
}))

jest.mock("@/lib/db/workflows", () => ({
  __esModule: true,
  listWorkflows: (...args: unknown[]) => listWorkflowsMock(...args),
}))

jest.mock("@/lib/db/workflow-deployments", () => ({
  __esModule: true,
  resolveWorkflowDeployment: (...args: unknown[]) => resolveWorkflowDeploymentMock(...args),
}))

jest.mock("@/lib/workflow/runtime/webhook-bridge", () => ({
  __esModule: true,
  syncWorkflowTriggers: (...args: unknown[]) => syncWorkflowTriggersMock(...args),
  unsyncWorkflowTriggers: (...args: unknown[]) => unsyncWorkflowTriggersMock(...args),
}))

jest.mock("@/lib/workflow/runtime/resume-controller", () => ({
  __esModule: true,
  resumeInFlightRuns: (...args: unknown[]) => resumeInFlightRunsMock(...args),
}))

jest.mock("@/lib/workflow/triggers/lifecycle", () => ({
  initPluginTriggerLifecycle: () => initPluginTriggerLifecycleMock(),
  disposePluginTriggerLifecycle: () => disposePluginTriggerLifecycleMock(),
}))

beforeEach(() => {
  installTriggerBridgeMock.mockReset()
  listWorkflowsMock.mockReset()
  syncWorkflowTriggersMock.mockReset()
  unsyncWorkflowTriggersMock.mockReset().mockResolvedValue(undefined)
  resolveWorkflowDeploymentMock.mockReset().mockImplementation(async (workflowId: string) => ({
    workflow: { id: workflowId, nodes: [], edges: [] },
  }))
  resumeInFlightRunsMock.mockReset()
  initPluginTriggerLifecycleMock.mockClear()
  disposePluginTriggerLifecycleMock.mockClear()
  registerScheduleHandoffDeliveryMock.mockReset().mockReturnValue(jest.fn())
  stopHostDispatchRuntimeMock.mockClear()
  installHostDispatchRuntimeMock.mockReset().mockReturnValue({
    kick: jest.fn(async () => undefined),
    stop: stopHostDispatchRuntimeMock,
  })
  // Default: nothing in-flight. Individual tests can override.
  resumeInFlightRunsMock.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 })
})

describe("WorkflowRuntimeProvider", () => {
  it("installs the trigger bridge and syncs every deployed workflow on mount", async () => {
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
    expect(registerScheduleHandoffDeliveryMock).toHaveBeenCalledTimes(1)
    expect(installHostDispatchRuntimeMock).toHaveBeenCalledWith({ accountId: "account-1" })
    await waitFor(() => expect(listWorkflowsMock).toHaveBeenCalledTimes(1))
    expect(resolveWorkflowDeploymentMock).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(syncWorkflowTriggersMock).toHaveBeenCalledTimes(2))
    expect(initPluginTriggerLifecycleMock).toHaveBeenCalledTimes(1)
    expect(syncWorkflowTriggersMock).toHaveBeenCalledWith(expect.objectContaining({ id: "wf_a" }), {
      signal: expect.any(AbortSignal),
    })
    expect(syncWorkflowTriggersMock).toHaveBeenCalledWith(expect.objectContaining({ id: "wf_b" }), {
      signal: expect.any(AbortSignal),
    })

    unmount()
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(stopHostDispatchRuntimeMock).toHaveBeenCalledTimes(1)
    expect(disposePluginTriggerLifecycleMock).toHaveBeenCalledTimes(1)
  })

  it("removes trigger registrations for workflows without an active deployment", async () => {
    installTriggerBridgeMock.mockResolvedValue(jest.fn())
    const draft = { id: "wf_draft", nodes: [], edges: [] }
    listWorkflowsMock.mockResolvedValue([draft])
    resolveWorkflowDeploymentMock.mockResolvedValue(undefined)

    render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(unsyncWorkflowTriggersMock).toHaveBeenCalledWith(draft))
    expect(syncWorkflowTriggersMock).not.toHaveBeenCalled()
  })

  it("does not sync template or built-in gallery workflows on mount", async () => {
    installTriggerBridgeMock.mockResolvedValue(jest.fn())
    listWorkflowsMock.mockResolvedValue([
      { id: "wf_active", nodes: [], edges: [] },
      { id: "wf_template", nodes: [], edges: [], isTemplate: true },
      { id: "wf_builtin", nodes: [], edges: [], isBuiltIn: true },
    ])
    syncWorkflowTriggersMock.mockResolvedValue(undefined)

    render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )

    await waitFor(() => expect(syncWorkflowTriggersMock).toHaveBeenCalledTimes(1))
    expect(syncWorkflowTriggersMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wf_active" }),
      { signal: expect.any(AbortSignal) }
    )
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

  it("does not start trigger projection after unmount while workflow loading is pending", async () => {
    installTriggerBridgeMock.mockResolvedValue(jest.fn())
    let resolveWorkflows!: (rows: Array<{ id: string; nodes: []; edges: [] }>) => void
    listWorkflowsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveWorkflows = resolve
      })
    )
    const { unmount } = render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )
    await waitFor(() => expect(listWorkflowsMock).toHaveBeenCalledTimes(1))

    unmount()
    resolveWorkflows([{ id: "wf_after_unmount", nodes: [], edges: [] }])
    await Promise.resolve()

    expect(syncWorkflowTriggersMock).not.toHaveBeenCalled()
    expect(disposePluginTriggerLifecycleMock).toHaveBeenCalledTimes(1)
  })

  it("aborts an in-progress trigger projection when the provider unmounts", async () => {
    installTriggerBridgeMock.mockResolvedValue(jest.fn())
    listWorkflowsMock.mockResolvedValue([{ id: "wf_pending_sync", nodes: [], edges: [] }])
    let resolveSync!: () => void
    syncWorkflowTriggersMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSync = resolve
      })
    )
    const { unmount } = render(
      <WorkflowRuntimeProvider>
        <div />
      </WorkflowRuntimeProvider>
    )
    await waitFor(() => expect(syncWorkflowTriggersMock).toHaveBeenCalledTimes(1))
    const options = syncWorkflowTriggersMock.mock.calls[0][1] as { signal: AbortSignal }

    unmount()

    expect(options.signal.aborted).toBe(true)
    resolveSync()
    await Promise.resolve()
    expect(resumeInFlightRunsMock).not.toHaveBeenCalled()
  })
})

/**
 * Regression guard: the provider is the SOLE production caller of
 * `installTriggerBridge` / `initTriggerSubscriptions` / `resumeInFlightRuns`.
 * If it is not mounted through the root layout's deferred boot bundle, every non-manual trigger (cron,
 * webhook, connector.inbound, chat.message, terminal.command, goal.completed),
 * boot-time trigger re-sync, and crash recovery silently go dormant — the
 * exact "built-but-never-wired" defect this test exists to prevent. We assert
 * against both source files (rendering the server root layout in jsdom is
 * impractical) so moving the runtime behind the shared dynamic boundary does
 * not weaken the reachability guard or accidentally mount a duplicate copy.
 */
describe("WorkflowRuntimeProvider — root layout wiring", () => {
  const layoutSource = readFileSync(resolve(__dirname, "../../app/layout.tsx"), "utf8")
  const deferredSource = readFileSync(
    resolve(__dirname, "initializers/deferred-boot-initializers.tsx"),
    "utf8"
  )
  const automationSource = readFileSync(
    resolve(__dirname, "initializers/workflow-automation-boot-initializers.tsx"),
    "utf8"
  )

  it("is imported by the workflow automation boot group", () => {
    expect(automationSource).toMatch(
      /import\s*\{\s*WorkflowRuntimeProvider\s*\}\s*from\s*["']@\/components\/providers\/workflow-runtime-provider["']/
    )
  })

  it("is mounted exactly once through the root layout's deferred boot bundle", () => {
    expect(automationSource.match(/<WorkflowRuntimeProvider\b/g)).toHaveLength(1)
    expect(deferredSource).toMatch(/<WorkflowAutomationBootInitializers\b/)
    expect(layoutSource).toMatch(/<DeferredBootInitializers\b/)
    expect(layoutSource).not.toMatch(/<WorkflowRuntimeProvider\b/)
  })
})
