/**
 * Tests for the desktop-pet workflow node executors. The pet event bus is
 * mocked at the module boundary — the controller side of the emission is
 * deep-tested in lib/pet/runtime/pet-controller.test.ts.
 */

const emitPetEvent = jest.fn()
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  emitPetEvent: (e: unknown) => emitPetEvent(e),
}))

import "./pet"
import { getExecutor } from "./registry"
import type { StepExecutionContext, TriggerEvent } from "@/types/workflow/visual"

function makeCtx(
  params: Record<string, unknown> = {},
  trigger?: Partial<TriggerEvent>
): StepExecutionContext {
  const controller = new AbortController()
  return {
    runId: "r1",
    workflowId: "w1",
    stepId: "s1",
    params,
    upstream: {},
    trigger: {
      kind: "trigger.manual",
      runId: "r1",
      workflowId: "w1",
      originAt: 0,
      payload: null,
      ...trigger,
    } as unknown as TriggerEvent,
    signal: controller.signal,
    log: () => {},
    resolveSecret: async () => undefined,
  }
}

beforeEach(() => {
  emitPetEvent.mockClear()
})

describe("action.pet.interact", () => {
  const executor = getExecutor("action.pet.interact", 1)!

  it("emits a workflow-sourced interaction event", async () => {
    const result = await executor.execute(makeCtx({ kind: "fed" }))
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "workflow", kind: "fed" })
    expect(result.output).toMatchObject({ kind: "fed" })
  })

  it("carries an optional shop-item id as meta.itemId", async () => {
    await executor.execute(makeCtx({ kind: "played", itemId: "yarn-ball" }))
    expect(emitPetEvent).toHaveBeenCalledWith({
      source: "workflow",
      kind: "played",
      meta: { itemId: "yarn-ball" },
    })
  })

  it("rejects non-interaction kinds", async () => {
    await expect(executor.execute(makeCtx({ kind: "levelUp" }))).rejects.toThrow(
      /action\.pet\.interact requires/
    )
    await expect(executor.execute(makeCtx({}))).rejects.toThrow(/action\.pet\.interact requires/)
    expect(emitPetEvent).not.toHaveBeenCalled()
  })
})

describe("trigger.pet.event (pass-through)", () => {
  const executor = getExecutor("trigger.pet.event", 1)!

  it("round-trips the trigger payload for manual runs", async () => {
    const result = await executor.execute(
      makeCtx({ kinds: ["levelUp", "unwell"] }, {
        originAt: 123,
        payload: { kind: "levelUp", level: 5 },
      } as Partial<TriggerEvent>)
    )
    expect(result.output).toEqual({
      kinds: ["levelUp", "unwell"],
      firedAt: 123,
      payload: { kind: "levelUp", level: 5 },
    })
  })
})
