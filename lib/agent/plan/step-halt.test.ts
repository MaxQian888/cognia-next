import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import {
  PLAN_RENDERER_BOOT_ID,
  __resetPlanRendererLockForTesting,
  holdPlanRendererLock,
  liveRendererBootIds,
  haltTrailReason,
  haltedStep,
  isOrphanedTurnDispatch,
  stepDisplayIndex,
} from "./step-halt"

function step(id: string, order: number): PlanStep {
  return {
    id,
    title: `title ${id}`,
    kind: "agent_turn",
    status: "pending",
    order,
    dependencies: [],
  }
}

const steps = [step("b", 1), step("a", 0), step("c", 2)]

describe("PLAN_RENDERER_BOOT_ID", () => {
  it("is a stable per-load identity", () => {
    expect(PLAN_RENDERER_BOOT_ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(PLAN_RENDERER_BOOT_ID).toBe(PLAN_RENDERER_BOOT_ID)
  })
})

describe("renderer liveness lock", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")

  function installLocks(locks: unknown): void {
    Object.defineProperty(globalThis, "navigator", {
      value: { locks },
      configurable: true,
      writable: true,
    })
  }

  afterEach(() => {
    __resetPlanRendererLockForTesting()
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete (globalThis as { navigator?: unknown }).navigator
  })

  it("holds one lock named after this load's boot id, once", () => {
    const request = jest.fn(() => new Promise(() => {}))
    installLocks({ request, query: jest.fn() })
    holdPlanRendererLock()
    holdPlanRendererLock()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      `cognia.plan-renderer:${PLAN_RENDERER_BOOT_ID}`,
      expect.any(Function)
    )
  })

  it("reports the boot ids whose locks are held, ignoring other locks", async () => {
    installLocks({
      request: jest.fn(),
      query: jest.fn(async () => ({
        held: [
          { name: "cognia.plan-renderer:tab-1" },
          { name: "something-else" },
          { name: "cognia.plan-renderer:tab-2" },
        ],
        pending: [],
      })),
    })
    expect(await liveRendererBootIds()).toEqual(new Set(["tab-1", "tab-2"]))
  })

  it("cannot tell without Web Locks, or when the query fails", async () => {
    installLocks(undefined)
    expect(await liveRendererBootIds()).toBeNull()
    holdPlanRendererLock()
    installLocks({ request: jest.fn(), query: jest.fn(async () => Promise.reject(new Error("x"))) })
    expect(await liveRendererBootIds()).toBeNull()
  })
})

describe("haltedStep", () => {
  it("returns the step the halt names", () => {
    expect(
      haltedStep({ steps, stepHalt: { stepId: "c", cause: "turn_failed", detail: "x", at: 1 } })?.id
    ).toBe("c")
  })

  it("returns undefined for a between-steps halt or a vanished step", () => {
    expect(haltedStep({ steps, stepHalt: { cause: "interrupted", detail: "x", at: 1 } })).toBe(
      undefined
    )
    expect(
      haltedStep({ steps, stepHalt: { stepId: "zz", cause: "turn_failed", detail: "x", at: 1 } })
    ).toBeUndefined()
    expect(haltedStep({ steps })).toBeUndefined()
  })
})

describe("stepDisplayIndex", () => {
  it("counts in display order, 1-based", () => {
    expect(stepDisplayIndex({ steps }, "a")).toBe(1)
    expect(stepDisplayIndex({ steps }, "c")).toBe(3)
    expect(stepDisplayIndex({ steps }, "missing")).toBe(0)
  })
})

describe("isOrphanedTurnDispatch", () => {
  const stamp = (bootId: string): Pick<AgentPlan, "turnDispatch"> => ({
    turnDispatch: { stepId: "a", bootId, dispatchedAt: 1 },
  })

  it("is false for a turn this renderer dispatched", () => {
    expect(isOrphanedTurnDispatch(stamp(PLAN_RENDERER_BOOT_ID))).toBe(false)
  })

  it("is true for another renderer's turn and for an unstamped row", () => {
    expect(isOrphanedTurnDispatch(stamp("previous-boot"))).toBe(true)
    expect(isOrphanedTurnDispatch({})).toBe(true)
    expect(isOrphanedTurnDispatch(stamp("x"), "x")).toBe(false)
  })
})

describe("haltTrailReason", () => {
  it("names the step, the cause and the detail", () => {
    expect(haltTrailReason({ title: "Build" }, { cause: "silent", detail: "no output" })).toBe(
      'step "Build" stopped (silent): no output'
    )
  })

  it("describes a halt between steps", () => {
    expect(haltTrailReason(undefined, { cause: "interrupted", detail: "app restarted" })).toBe(
      "the in-session run stopped (interrupted): app restarted"
    )
  })
})
