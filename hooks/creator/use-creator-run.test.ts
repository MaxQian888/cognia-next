/** @jest-environment jsdom */
const mockAppend = jest.fn(async () => undefined)
jest.mock("@/lib/creator/run-log", () => ({
  ...jest.requireActual("@/lib/creator/run-log"),
  // The log writes to Dexie; the hook's contract is that it passes one through,
  // not what the log itself does.
  createCreatorRunLog: () => new Proxy({}, { get: () => mockAppend }),
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { useCreatorRun } from "./use-creator-run"
import { createCreatorHandlers } from "@/lib/creator/handlers"
import { CREATOR_STEP_IDS } from "@/lib/creator/steps"
import type { CreatorHandlers, CreatorRunContext } from "@/lib/creator/executor"
import type { AuthoringRoot } from "@/types/creator"

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

const ctx: CreatorRunContext = {
  runId: "creator_1",
  root,
  artifactKind: "plugin",
  requirements: "r",
  currentCapabilities: [],
  approvedAdditions: [],
}

function workingHandlers(overrides: Partial<CreatorHandlers> = {}): CreatorHandlers {
  return createCreatorHandlers({
    collectRequirements: async () => ({ requirements: "collected" }),
    surveyExisting: async () => ({ findings: [] }),
    planScaffold: async () => ({ files: [], capabilities: [] }),
    ...overrides,
  })
}

beforeEach(() => mockAppend.mockClear())

describe("useCreatorRun", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useCreatorRun({ handlers: workingHandlers() }))
    expect(result.current.busy).toBe(false)
    expect(result.current.activeStep).toBeNull()
    expect(result.current.lastOutcome).toBeNull()
  })

  it("advances to the first approval gate and reports where it stopped", async () => {
    const { result } = renderHook(() => useCreatorRun({ handlers: workingHandlers() }))

    await act(async () => {
      await result.current.advance(ctx, { completed: [], approvals: [] })
    })

    expect(result.current.lastOutcome?.status).toBe("awaiting-approval")
    expect(result.current.lastOutcome?.step).toBe("approve-permissions")
    expect(result.current.busy).toBe(false)
  })

  it("surfaces an unconnected port as a failed step rather than swallowing it", async () => {
    // The default handler set fails loudly; that failure has to reach the UI.
    const { result } = renderHook(() => useCreatorRun({ handlers: createCreatorHandlers() }))

    await act(async () => {
      await result.current.advance(ctx, { completed: [], approvals: [] })
    })

    expect(result.current.lastOutcome?.status).toBe("failed")
    expect(result.current.lastOutcome?.detail).toMatch(/not connected/)
  })

  it("runs a single step on demand", async () => {
    const { result } = renderHook(() => useCreatorRun({ handlers: workingHandlers() }))

    await act(async () => {
      await result.current.step("collect-requirements", ctx, { completed: [], approvals: [] })
    })

    expect(result.current.lastOutcome?.status).toBe("completed")
    expect(result.current.lastOutcome?.ran).toEqual(["collect-requirements"])
  })

  // The plan lives only in this hook; carrying it is the whole reason the hook
  // holds state at all.
  it("carries the plan between advances so a resumed run does not lose it", async () => {
    const planScaffold = jest.fn(async () => ({
      files: [{ relativePath: "a.ts", contents: "1" }],
      capabilities: [],
    }))
    const { result } = renderHook(() =>
      useCreatorRun({ handlers: workingHandlers({ planScaffold }) })
    )

    await act(async () => {
      await result.current.advance(ctx, { completed: [], approvals: [] })
    })
    expect(planScaffold).toHaveBeenCalledTimes(1)

    // Second advance, now past the gate: the plan is already in hand, so the
    // generator is not re-invoked.
    await act(async () => {
      await result.current.advance(ctx, {
        completed: CREATOR_STEP_IDS.slice(0, 3),
        approvals: ["permission-widening"],
      })
    })
    expect(planScaffold).toHaveBeenCalledTimes(1)
  })

  it("re-runs the generator after a reset", async () => {
    const planScaffold = jest.fn(async () => ({ files: [], capabilities: [] }))
    const { result } = renderHook(() =>
      useCreatorRun({ handlers: workingHandlers({ planScaffold }) })
    )

    await act(async () => {
      await result.current.advance(ctx, { completed: [], approvals: [] })
    })
    act(() => result.current.reset())
    expect(result.current.lastOutcome).toBeNull()

    await act(async () => {
      await result.current.advance(ctx, {
        completed: CREATOR_STEP_IDS.slice(0, 3),
        approvals: ["permission-widening"],
      })
    })
    expect(planScaffold).toHaveBeenCalledTimes(2)
  })

  it("ignores a second advance while one is in flight", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const collectRequirements = jest.fn(async () => {
      await gate
      return { requirements: "collected" }
    })
    const { result } = renderHook(() =>
      useCreatorRun({ handlers: workingHandlers({ collectRequirements }) })
    )

    let first: Promise<void> = Promise.resolve()
    act(() => {
      first = result.current.advance(ctx, { completed: [], approvals: [] })
    })
    await waitFor(() => expect(result.current.busy).toBe(true))

    await act(async () => {
      await result.current.advance(ctx, { completed: [], approvals: [] })
    })
    expect(collectRequirements).toHaveBeenCalledTimes(1)

    release()
    await act(async () => {
      await first
    })
  })
})
