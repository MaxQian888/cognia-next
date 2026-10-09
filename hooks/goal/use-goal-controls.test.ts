/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import type { Goal, GoalConfig } from "@/types/goal"

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: jest.fn(() => "unknown") }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }))
jest.mock("@/lib/goal/runtime", () => {
  const runtime = {
    pauseGoal: jest.fn(async () => undefined),
    resumeGoal: jest.fn(async () => undefined),
    stopGoal: jest.fn(async () => undefined),
    requestManualContinue: jest.fn(),
    updateObjective: jest.fn(async () => undefined),
    updateConfig: jest.fn(async () => undefined),
    deleteGoal: jest.fn(async () => undefined),
    setSubgoalDone: jest.fn(async () => undefined),
    clearSubgoals: jest.fn(async () => undefined),
  }
  return { getGoalRuntime: jest.fn(() => runtime) }
})
jest.mock("@/lib/goal/subgoal-generation", () => ({ generateGoalSubgoals: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: { id: "host-settings" } }) },
}))
jest.mock("@/lib/goal/acceptance", () => ({ resolveGoalAcceptance: jest.fn() }))
jest.mock("@/lib/goal/verification", () => ({
  disableGoalVerification: jest.fn(),
  retryPausedGoalVerification: jest.fn(),
}))

import { toast } from "sonner"
import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { generateGoalSubgoals } from "@/lib/goal/subgoal-generation"
import { disableGoalVerification, retryPausedGoalVerification } from "@/lib/goal/verification"
import { transport } from "@/lib/tauri/transport-instance"
import { useGoalControls } from "./use-goal-controls"

const usePlatformMock = usePlatform as jest.Mock
const useCanControlMock = useCanControl as jest.Mock
const callMock = transport.call as jest.Mock
const toastError = toast.error as jest.Mock
const toastSuccess = toast.success as jest.Mock
const toastInfo = toast.info as jest.Mock
const resolveAcceptanceMock = resolveGoalAcceptance as jest.Mock
const disableVerificationMock = disableGoalVerification as jest.Mock
const retryVerificationMock = retryPausedGoalVerification as jest.Mock
const generateSubgoalsMock = generateGoalSubgoals as jest.Mock
const runtime = (getGoalRuntime as jest.Mock)() as Record<string, jest.Mock>

const CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 1_800_000,
}

function goal(overrides: Partial<Pick<Goal, "id" | "status" | "config">> = {}) {
  return { id: "g1", status: "active" as const, config: CONFIG, ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  usePlatformMock.mockReturnValue("tauri")
  useCanControlMock.mockReturnValue("unknown")
  for (const fn of Object.values(runtime)) fn.mockReset()
  for (const key of [
    "pauseGoal",
    "resumeGoal",
    "stopGoal",
    "updateConfig",
    "deleteGoal",
    "setSubgoalDone",
    "clearSubgoals",
  ]) {
    runtime[key]!.mockResolvedValue(undefined)
  }
  resolveAcceptanceMock.mockReset().mockResolvedValue({ id: "g1" })
  disableVerificationMock.mockReset().mockResolvedValue({ id: "g1" })
  retryVerificationMock.mockReset()
  generateSubgoalsMock.mockReset()
  callMock.mockReset().mockResolvedValue(undefined)
})

describe("useGoalControls — local host", () => {
  it("is allowed and not remote", () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    expect(result.current.remote).toBe(false)
    expect(result.current.allowed).toBe(true)
    expect(result.current.busy).toBe(false)
  })

  it.each([
    ["pause", "pauseGoal"],
    ["resume", "resumeGoal"],
    ["stop", "stopGoal"],
  ] as const)("%s drives the runtime directly", async (verb, method) => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current[verb]()
    })
    expect(ok).toBe(true)
    expect(runtime[method]).toHaveBeenCalledWith("g1")
    expect(callMock).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it("reports a runtime failure with the error and resolves false", async () => {
    runtime.pauseGoal!.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = true
    await act(async () => {
      ok = await result.current.pause()
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't update the goal", { description: "boom" })
    expect(result.current.busy).toBe(false)
  })

  it("does nothing without a goal", async () => {
    const { result } = renderHook(() => useGoalControls(null))
    let ok = true
    let objective = ""
    let config = true
    await act(async () => {
      ok = await result.current.stop()
      objective = await result.current.updateObjective("x")
      config = await result.current.updateConfig({ maxTurns: 3 })
    })
    expect(ok).toBe(false)
    expect(objective).toBe("failed")
    expect(config).toBe(false)
    expect(runtime.stopGoal).not.toHaveBeenCalled()
    expect(result.current.canContinue).toBe(false)
  })

  it("updateObjective reports updated / unchanged / failed", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    runtime.updateObjective!.mockResolvedValueOnce({ id: "g1" })
    runtime.updateObjective!.mockResolvedValueOnce(null)
    runtime.updateObjective!.mockRejectedValueOnce("nope")
    const outcomes: string[] = []
    await act(async () => {
      outcomes.push(await result.current.updateObjective("new"))
      outcomes.push(await result.current.updateObjective("same"))
      outcomes.push(await result.current.updateObjective("bad"))
    })
    expect(outcomes).toEqual(["updated", "unchanged", "failed"])
    expect(runtime.updateObjective).toHaveBeenCalledWith("g1", "new")
    expect(toastError).toHaveBeenCalledWith("Couldn't update the goal", { description: "nope" })
  })

  it("updateConfig patches through the runtime", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current.updateConfig({ maxTurns: 5 })
    })
    expect(ok).toBe(true)
    expect(runtime.updateConfig).toHaveBeenCalledWith("g1", { maxTurns: 5 })

    runtime.updateConfig!.mockRejectedValueOnce(new Error("bad"))
    await act(async () => {
      ok = await result.current.updateConfig({ maxTurns: 6 })
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it("canContinue only for an active manual-continue goal, and continueTurn drives the runtime", async () => {
    const manual = { ...CONFIG, manualContinue: true }
    const { result, rerender } = renderHook(
      ({ g }: { g: ReturnType<typeof goal> }) => useGoalControls(g),
      { initialProps: { g: goal({ config: manual }) } }
    )
    expect(result.current.canContinue).toBe(true)
    runtime.requestManualContinue!.mockReturnValueOnce(true).mockReturnValueOnce(false)
    const released: boolean[] = []
    await act(async () => {
      released.push(await result.current.continueTurn())
      released.push(await result.current.continueTurn())
    })
    expect(released).toEqual([true, false])
    expect(runtime.requestManualContinue).toHaveBeenCalledWith("g1")
    expect(callMock).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()

    rerender({ g: goal({ status: "paused", config: manual }) })
    expect(result.current.canContinue).toBe(false)
    rerender({ g: goal() })
    expect(result.current.canContinue).toBe(false)
  })

  it("accept records the verdict locally and says what it did", async () => {
    const { result } = renderHook(() => useGoalControls(goal({ status: "paused" })))
    const oks: boolean[] = []
    await act(async () => {
      oks.push(await result.current.accept(true))
      oks.push(await result.current.accept(false))
    })
    expect(oks).toEqual([true, true])
    expect(resolveAcceptanceMock).toHaveBeenNthCalledWith(1, "g1", true)
    expect(resolveAcceptanceMock).toHaveBeenNthCalledWith(2, "g1", false)
    expect(toastSuccess).toHaveBeenNthCalledWith(1, "Accepted — the goal is complete.")
    expect(toastSuccess).toHaveBeenNthCalledWith(2, "Changes requested — the goal resumed.")
    expect(callMock).not.toHaveBeenCalled()
  })

  it("accept reports a local failure under the verdict title", async () => {
    resolveAcceptanceMock.mockRejectedValueOnce(new Error("db closed"))
    const { result } = renderHook(() => useGoalControls(goal({ status: "paused" })))
    let ok = true
    await act(async () => {
      ok = await result.current.accept(true)
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't record your verdict", {
      description: "db closed",
    })
  })

  it("deleteGoal deletes through the runtime and confirms", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current.deleteGoal()
    })
    expect(ok).toBe(true)
    expect(runtime.deleteGoal).toHaveBeenCalledWith("g1")
    expect(toastSuccess).toHaveBeenCalledWith("Goal deleted")

    runtime.deleteGoal!.mockRejectedValueOnce(new Error("locked"))
    await act(async () => {
      ok = await result.current.deleteGoal()
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't delete the goal", { description: "locked" })
  })

  it("disableVerification and retryVerification run the verifier module here", async () => {
    const outcome = { kind: "passed", result: { passed: true, summary: "ok" } }
    retryVerificationMock.mockResolvedValueOnce(outcome)
    const { result } = renderHook(() => useGoalControls(goal()))
    let disabled = false
    let retried: unknown = null
    await act(async () => {
      disabled = await result.current.disableVerification()
      retried = await result.current.retryVerification()
    })
    expect(disabled).toBe(true)
    expect(disableVerificationMock).toHaveBeenCalledWith("g1")
    expect(retried).toEqual({ state: "settled", outcome })
    expect(retryVerificationMock).toHaveBeenCalledWith("g1")

    retryVerificationMock.mockRejectedValueOnce(new Error("Goal has no verification candidate"))
    await act(async () => {
      retried = await result.current.retryVerification()
    })
    expect(retried).toBeNull()
    expect(toastError).toHaveBeenCalledWith("Couldn't update the goal", {
      description: "Goal has no verification candidate",
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it("treats the web platform as its own host", () => {
    usePlatformMock.mockReturnValue("web")
    const { result } = renderHook(() => useGoalControls(goal()))
    expect(result.current.remote).toBe(false)
    expect(result.current.allowed).toBe(true)
  })

  describe("subgoals", () => {
    it("generateSubgoals runs the shared generator with this host's settings", async () => {
      generateSubgoalsMock
        .mockResolvedValueOnce({ outcome: "generated", goal: { id: "g1" } })
        .mockResolvedValueOnce({ outcome: "unavailable", goal: { id: "g1" } })
        .mockRejectedValueOnce(new Error("db closed"))
      const { result } = renderHook(() => useGoalControls(goal()))
      const outcomes: string[] = []
      await act(async () => {
        outcomes.push(await result.current.generateSubgoals())
        outcomes.push(await result.current.generateSubgoals())
        outcomes.push(await result.current.generateSubgoals())
      })
      expect(outcomes).toEqual(["generated", "unavailable", "failed"])
      expect(generateSubgoalsMock).toHaveBeenCalledWith("g1", { id: "host-settings" })
      expect(callMock).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith("Couldn't update the goal", {
        description: "db closed",
      })
    })

    it("setSubgoalDone and clearSubgoals drive the runtime, failures under their own titles", async () => {
      const { result } = renderHook(() => useGoalControls(goal()))
      const oks: boolean[] = []
      await act(async () => {
        oks.push(await result.current.setSubgoalDone("s1", true))
        oks.push(await result.current.clearSubgoals())
      })
      expect(oks).toEqual([true, true])
      expect(runtime.setSubgoalDone).toHaveBeenCalledWith("g1", "s1", true)
      expect(runtime.clearSubgoals).toHaveBeenCalledWith("g1")
      expect(callMock).not.toHaveBeenCalled()

      runtime.setSubgoalDone!.mockRejectedValueOnce(new Error("locked"))
      runtime.clearSubgoals!.mockRejectedValueOnce(new Error("gone"))
      await act(async () => {
        oks.push(await result.current.setSubgoalDone("s1", false))
        oks.push(await result.current.clearSubgoals())
      })
      expect(oks.slice(2)).toEqual([false, false])
      expect(toastError).toHaveBeenCalledWith("Couldn't update the step", { description: "locked" })
      expect(toastError).toHaveBeenCalledWith("Couldn't clear the checklist", {
        description: "gone",
      })
    })
  })
})

describe("useGoalControls — mobile companion", () => {
  beforeEach(() => {
    usePlatformMock.mockReturnValue("mobile")
  })

  it("is remote and allowed only with the control grant", () => {
    useCanControlMock.mockReturnValue("unknown")
    const { result, rerender } = renderHook(() => useGoalControls(goal()))
    expect(result.current.remote).toBe(true)
    expect(result.current.allowed).toBe(false)

    useCanControlMock.mockReturnValue(false)
    rerender()
    expect(result.current.allowed).toBe(false)

    useCanControlMock.mockReturnValue(true)
    rerender()
    expect(result.current.allowed).toBe(true)
  })

  it.each([
    ["pause", "goal_pause"],
    ["resume", "goal_resume"],
    ["stop", "goal_stop"],
  ] as const)("%s round-trips through %s", async (verb, command) => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current[verb]()
    })
    expect(ok).toBe(true)
    expect(callMock).toHaveBeenCalledWith(command, { goalId: "g1" })
    expect(runtime.pauseGoal).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("Applied on desktop.")
  })

  it("reports an RPC failure with the remote message and resolves false", async () => {
    callMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = true
    await act(async () => {
      ok = await result.current.stop()
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("updateObjective goes over goal_update", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    callMock.mockResolvedValueOnce({ goal: { id: "g1" }, updatePrompt: "re-aimed" })
    // The desktop answers the stored row when the runtime refused the update,
    // so a goal alone is not an applied update; only the update prompt is.
    callMock.mockResolvedValueOnce({ goal: { id: "g1" } })
    callMock.mockResolvedValueOnce({ goal: null })
    callMock.mockResolvedValueOnce(undefined)
    callMock.mockRejectedValueOnce(new Error("x"))
    const outcomes: string[] = []
    await act(async () => {
      outcomes.push(await result.current.updateObjective("a"))
      outcomes.push(await result.current.updateObjective("b"))
      outcomes.push(await result.current.updateObjective("c"))
      outcomes.push(await result.current.updateObjective("d"))
      outcomes.push(await result.current.updateObjective("e"))
    })
    expect(outcomes).toEqual(["updated", "unchanged", "unchanged", "unchanged", "failed"])
    expect(callMock).toHaveBeenCalledWith("goal_update", { goalId: "g1", rawObjective: "a" })
    expect(runtime.updateObjective).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
  })

  it("updateConfig goes over goal_update", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current.updateConfig({ maxTokens: 9 })
    })
    expect(ok).toBe(true)
    expect(callMock).toHaveBeenCalledWith("goal_update", { goalId: "g1", config: { maxTokens: 9 } })
    expect(runtime.updateConfig).not.toHaveBeenCalled()
  })

  it("offers a manual continue only with the control grant", () => {
    const manual = goal({ config: { ...CONFIG, manualContinue: true } })
    useCanControlMock.mockReturnValue("unknown")
    const { result, rerender } = renderHook(() => useGoalControls(manual))
    expect(result.current.canContinue).toBe(false)
    useCanControlMock.mockReturnValue(true)
    rerender()
    expect(result.current.canContinue).toBe(true)
  })

  it("continueTurn goes over goal_continue and says when nothing was waiting", async () => {
    useCanControlMock.mockReturnValue(true)
    const { result } = renderHook(() =>
      useGoalControls(goal({ config: { ...CONFIG, manualContinue: true } }))
    )
    callMock.mockResolvedValueOnce({ continued: true }).mockResolvedValueOnce({ continued: false })
    const released: boolean[] = []
    await act(async () => {
      released.push(await result.current.continueTurn())
      released.push(await result.current.continueTurn())
    })
    expect(released).toEqual([true, false])
    expect(callMock).toHaveBeenCalledWith("goal_continue", { goalId: "g1" })
    expect(runtime.requestManualContinue).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("Applied on desktop.")
    expect(toastInfo).toHaveBeenCalledWith("The desktop has no turn waiting to continue.")
  })

  it.each([true, false])("accept(%s) goes over goal_accept", async (accepted) => {
    const { result } = renderHook(() => useGoalControls(goal({ status: "paused" })))
    let ok = false
    await act(async () => {
      ok = await result.current.accept(accepted)
    })
    expect(ok).toBe(true)
    expect(callMock).toHaveBeenCalledWith("goal_accept", { goalId: "g1", accepted })
    expect(resolveAcceptanceMock).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("Applied on desktop.")
  })

  it("accept reports an RPC failure with the remote message", async () => {
    callMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useGoalControls(goal({ status: "paused" })))
    let ok = true
    await act(async () => {
      ok = await result.current.accept(true)
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
  })

  it("deleteGoal goes over goal_delete", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current.deleteGoal()
    })
    expect(ok).toBe(true)
    expect(callMock).toHaveBeenCalledWith("goal_delete", { goalId: "g1" })
    expect(runtime.deleteGoal).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith("Goal deleted")

    callMock.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      ok = await result.current.deleteGoal()
    })
    expect(ok).toBe(false)
    expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
  })

  it("disableVerification sends an explicit null verifier over goal_update", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    let ok = false
    await act(async () => {
      ok = await result.current.disableVerification()
    })
    expect(ok).toBe(true)
    expect(callMock).toHaveBeenCalledWith("goal_update", {
      goalId: "g1",
      config: { verificationWorkflow: null },
    })
    expect(disableVerificationMock).not.toHaveBeenCalled()
  })

  it("retryVerification answers what goal_verify_retry answered", async () => {
    const { result } = renderHook(() => useGoalControls(goal()))
    const settled = { state: "settled", outcome: { kind: "error", error: "verifier down" } }
    callMock.mockResolvedValueOnce(settled).mockResolvedValueOnce({ state: "running" })
    const answers: unknown[] = []
    await act(async () => {
      answers.push(await result.current.retryVerification())
      answers.push(await result.current.retryVerification())
    })
    expect(answers).toEqual([settled, { state: "running" }])
    expect(callMock).toHaveBeenCalledWith("goal_verify_retry", { goalId: "g1" })
    expect(retryVerificationMock).not.toHaveBeenCalled()

    callMock.mockRejectedValueOnce(new Error("offline"))
    let failed: unknown = "unset"
    await act(async () => {
      failed = await result.current.retryVerification()
    })
    expect(failed).toBeNull()
    expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
  })

  describe("subgoals", () => {
    it("generateSubgoals goes over goal_subgoals_generate and answers its outcome", async () => {
      const { result } = renderHook(() => useGoalControls(goal()))
      callMock
        .mockResolvedValueOnce({ outcome: "generated", goal: { id: "g1" } })
        .mockResolvedValueOnce({ outcome: "running" })
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("403"))
      const outcomes: string[] = []
      await act(async () => {
        outcomes.push(await result.current.generateSubgoals())
        outcomes.push(await result.current.generateSubgoals())
        outcomes.push(await result.current.generateSubgoals())
        outcomes.push(await result.current.generateSubgoals())
      })
      expect(outcomes).toEqual(["generated", "running", "failed", "failed"])
      expect(callMock).toHaveBeenCalledWith("goal_subgoals_generate", { goalId: "g1" })
      expect(generateSubgoalsMock).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
    })

    it("setSubgoalDone sends the wanted state over goal_subgoal_mark", async () => {
      const { result } = renderHook(() => useGoalControls(goal()))
      let ok = false
      await act(async () => {
        ok = await result.current.setSubgoalDone("s2", false)
      })
      expect(ok).toBe(true)
      expect(callMock).toHaveBeenCalledWith("goal_subgoal_mark", {
        goalId: "g1",
        subgoalId: "s2",
        done: false,
      })
      expect(runtime.setSubgoalDone).not.toHaveBeenCalled()

      callMock.mockRejectedValueOnce(new Error("offline"))
      await act(async () => {
        ok = await result.current.setSubgoalDone("s2", true)
      })
      expect(ok).toBe(false)
      expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
    })

    it("clearSubgoals goes over goal_subgoals_clear", async () => {
      const { result } = renderHook(() => useGoalControls(goal()))
      let ok = false
      await act(async () => {
        ok = await result.current.clearSubgoals()
      })
      expect(ok).toBe(true)
      expect(callMock).toHaveBeenCalledWith("goal_subgoals_clear", { goalId: "g1" })
      expect(runtime.clearSubgoals).not.toHaveBeenCalled()
    })
  })
})
