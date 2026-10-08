/** @jest-environment jsdom */

// The Squad control state machine, without any surface around it. The
// masthead suite covers how it is rendered; this one covers what it decides.

import { act, renderHook, waitFor } from "@testing-library/react"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { DEFAULT_TEAM_CONFIG, type AgentTeam } from "@/types/agent/agent-team"
import type { ExecutionRun, RunControlAction } from "@/types/execution/run"
import type { HostProfile } from "@/lib/platform/capabilities"
import type { SquadStartOutcome } from "@/lib/execution/squad-start-dispatch"

const mockDispatch = jest.fn<Promise<SquadStartOutcome>, []>()
const mockCreateAttempt = jest.fn()
const mockControl = jest.fn()
const mockToast = jest.fn()
let mockProfile: HostProfile = "desktop"
let mockRemoteActive = false
let mockRun: ExecutionRun | null = null
let mockReadiness = { ready: true, loading: false, blockers: [] as { code: string }[] }

jest.mock("@/lib/execution/squad-start-dispatch", () => ({
  createSquadStartAttempt: (...args: unknown[]) => mockCreateAttempt(...args),
}))
jest.mock("@/lib/execution/run-control-dispatch", () => ({
  dispatchRunControl: (...args: unknown[]) => mockControl(...args),
}))
jest.mock("@/hooks/squads/use-squad-latest-run", () => ({
  useSquadLatestRun: () => ({ run: mockRun, record: null, loading: false }),
}))
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockProfile,
  useRemoteHostActive: () => mockRemoteActive,
}))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToast(...args) } }))
jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ...mockReadiness, evaluatedAt: 1 }),
}))

import { useSquadRunControl } from "./use-squad-run-control"

function run(
  allowedActions: RunControlAction[],
  status: ExecutionRun["status"] = "running"
): ExecutionRun {
  return {
    id: "execution:team:canonical",
    kind: "team",
    sourceId: "canonical",
    title: "Review",
    status,
    currentRevision: 7,
    startedAt: 1,
    updatedAt: 2,
    latestSnapshot: {
      runId: "execution:team:canonical",
      kind: "team",
      teamId: "a",
      title: "Review",
      status,
      revision: 7,
      startedAt: 1,
      updatedAt: 2,
      progress: { completed: 0, total: 0, trustworthy: false },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1,
      artifacts: [],
      allowedActions,
    },
  } as ExecutionRun
}

beforeEach(() => {
  jest.clearAllMocks()
  mockProfile = "desktop"
  mockRemoteActive = false
  mockRun = null
  mockReadiness = { ready: true, loading: false, blockers: [] }
  mockDispatch.mockReset().mockResolvedValue({
    started: true,
    runId: "canonical",
    executionRunId: "execution:team:canonical",
  })
  mockCreateAttempt.mockImplementation(() => ({ launchId: "gesture", dispatch: mockDispatch }))
  mockControl.mockResolvedValue({ accepted: true })
  const squad = {
    id: "a",
    name: "Review Crew",
    description: "",
    status: "idle",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: DEFAULT_TEAM_CONFIG,
    task: "Review release",
    leadId: "lead",
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
  } as AgentTeam
  useAgentTeamStore.setState({ teams: { a: squad } })
})

describe("status", () => {
  it("reads the Squad's own status before its first run", () => {
    const { result } = renderHook(() => useSquadRunControl("a"))
    expect(result.current.status).toBe("idle")
    expect(result.current.run).toBeNull()
  })

  /** The durable run wins over the store's optimistic status. */
  it("reads a resumable run as paused and any other live run as executing", () => {
    mockRun = run(["resume", "stop"])
    expect(renderHook(() => useSquadRunControl("a")).result.current.status).toBe("paused")
    mockRun = run(["pause", "stop"])
    expect(renderHook(() => useSquadRunControl("a")).result.current.status).toBe("executing")
  })

  it.each(["completed", "failed", "cancelled"] as const)("reads a %s run as settled", (status) => {
    mockRun = run([], status)
    expect(renderHook(() => useSquadRunControl("a")).result.current.status).toBe(status)
  })

  it("offers exactly the controls the canonical snapshot allows", () => {
    mockRun = run(["stop"])
    const { result } = renderHook(() => useSquadRunControl("a"))
    expect(result.current).toMatchObject({ canPause: false, canResume: false, canStop: true })
  })
})

describe("start availability", () => {
  it("is available when the Squad is ready", () => {
    expect(renderHook(() => useSquadRunControl("a")).result.current.startDisabledReason).toBe(
      undefined
    )
  })

  it("says it is checking while readiness loads", () => {
    mockReadiness = { ready: false, loading: true, blockers: [] }
    expect(renderHook(() => useSquadRunControl("a")).result.current.startDisabledReason).toBe(
      "Checking…"
    )
  })

  it("names the first local blocker", () => {
    mockReadiness = {
      ready: false,
      loading: false,
      blockers: [{ code: "missing_environment_ref" }],
    }
    expect(renderHook(() => useSquadRunControl("a")).result.current.startDisabledReason).toMatch(
      /No environment is chosen/
    )
  })

  /** Environment state is not mirrored to a companion; the Host judges it. */
  it.each([
    ["a mobile companion", "mobile-companion" as HostProfile, false],
    ["an active remote host", "desktop" as HostProfile, true],
  ])("lets %s start despite local blockers", (_label, profile, remoteActive) => {
    mockProfile = profile
    mockRemoteActive = remoteActive
    mockReadiness = { ready: false, loading: false, blockers: [{ code: "host_unavailable" }] }
    const { result } = renderHook(() => useSquadRunControl("a"))
    expect(result.current.remote).toBe(true)
    expect(result.current.startDisabledReason).toBeUndefined()
  })

  it("waits for the started run to reach the journal before offering Start again", async () => {
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(result.current.startDisabledReason).toBe("Waiting for the Host run to sync…")
  })
})

describe("start", () => {
  it("starts through the surface dispatcher for this Squad and host", async () => {
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(mockCreateAttempt).toHaveBeenCalledWith({ teamId: "a", hostProfile: "desktop" })
  })

  it("passes an ultracode start through", async () => {
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start({ ultracode: true }))
    expect(mockCreateAttempt).toHaveBeenCalledWith({
      teamId: "a",
      hostProfile: "desktop",
      ultracode: true,
    })
  })

  it("lets only one start through while one is pending", async () => {
    let finish!: (result: SquadStartOutcome) => void
    mockDispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useSquadRunControl("a"))
    let first!: Promise<void>
    act(() => {
      first = result.current.start()
      void result.current.start()
    })
    expect(result.current.busy).toBe(true)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ started: false, reason: "not_ready" })
      await first
    })
    expect(result.current.busy).toBe(false)
  })

  /** A lost response must replay the SAME launch, or one gesture becomes two runs. */
  it("retries a retryable refusal on the same attempt", async () => {
    mockDispatch.mockResolvedValueOnce({
      started: false,
      reason: "host_consent_required",
      consentCode: "ABC123",
    })
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(result.current.retryable).toBe(true)
    expect(result.current.refusalMessage).toMatch(/Authorize this device/)
    await act(() => result.current.start({ retry: true }))
    expect(mockCreateAttempt).toHaveBeenCalledTimes(1)
    expect(mockDispatch).toHaveBeenCalledTimes(2)
  })

  it("starts a new attempt after a definitive refusal", async () => {
    mockDispatch.mockResolvedValueOnce({ started: false, reason: "not_ready" })
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(result.current.retryable).toBe(false)
    await act(() => result.current.start())
    expect(mockCreateAttempt).toHaveBeenCalledTimes(2)
  })

  it("renders every Host blocker returned with a refusal", async () => {
    mockDispatch.mockResolvedValueOnce({
      started: false,
      reason: "not_ready",
      blockers: [{ code: "missing_environment_ref" }, { code: "no_teammates" }],
    })
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(result.current.refusalBlockers).toHaveLength(2)
    expect(result.current.refusalBlockers[0]).toMatch(/No environment is chosen/)
  })

  it("falls back to the generic refusal for a reason it has no words for", async () => {
    mockDispatch.mockResolvedValueOnce({ started: false, reason: "brand_new_reason" as never })
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.start())
    expect(result.current.refusalMessage).toMatch(/could not be confirmed/)
  })
})

describe("control", () => {
  it.each(["pause", "resume", "stop"] as const)(
    "sends %s against the canonical execution id",
    async (action) => {
      mockRun = run([action])
      const { result } = renderHook(() => useSquadRunControl("a"))
      await act(() => result.current.control(action))
      expect(mockControl).toHaveBeenCalledWith({
        runId: "execution:team:canonical",
        action,
        surface: "squad-inspector",
        hostProfile: "desktop",
      })
    }
  )

  it("does nothing without a run", async () => {
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.control("pause"))
    expect(mockControl).not.toHaveBeenCalled()
  })

  it("explains a refused control with its Host consent code", async () => {
    mockRun = run(["pause"])
    mockControl.mockResolvedValueOnce({
      accepted: false,
      reason: "host_consent_required",
      consentCode: "CONTROL",
    })
    const { result } = renderHook(() => useSquadRunControl("a"))
    await act(() => result.current.control("pause"))
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith("Couldn't pause the Squad", {
        description: expect.stringContaining("CONTROL"),
      })
    )
  })
})
