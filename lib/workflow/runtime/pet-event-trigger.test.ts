/**
 * Tests for the `trigger.pet.event` runner. The trigger bridge is mocked at
 * the module boundary and the subscription cache is seeded directly, so the
 * runner's matching / cooldown / projection logic is exercised in isolation
 * via `_injectPetEventForTest`.
 */

const dispatchTrigger = jest.fn().mockResolvedValue(undefined)
jest.mock("./trigger-bridge", () => ({
  dispatchTrigger: (args: unknown) => dispatchTrigger(args),
}))

import {
  _injectPetEventForTest,
  disposePetEventTrigger,
  initPetEventTrigger,
} from "./pet-event-trigger"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"
import type { PetEvent } from "@/types/pet"
import type { WorkflowRow } from "@/types/workflow/visual"

function workflowWithPetTrigger(id: string, params: Record<string, unknown> = {}): WorkflowRow {
  return {
    id,
    nodes: [{ id: `${id}-n1`, type: "trigger.pet.event", data: { params } }],
  } as unknown as WorkflowRow
}

function event(kind: PetEvent["kind"], meta?: Record<string, unknown>): PetEvent {
  return { source: "system", kind, meta, at: 1000 }
}

let clock = 0

beforeEach(() => {
  dispatchTrigger.mockClear()
  clock = 100_000
  initPetEventTrigger({ now: () => clock })
})

afterEach(() => {
  disposePetEventTrigger()
  _seedTriggerSubscriptionsForTest([])
})

describe("pet-event-trigger", () => {
  it("fires matching workflows with a projected payload", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(
      event("achievementUnlocked", { achievementId: "well-fed", userText: "SECRET" })
    )
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledWith({
      workflowId: "wf1",
      kind: "trigger.pet.event",
      payload: { kind: "achievementUnlocked", at: 1000, achievementId: "well-fed" },
      originAt: 100_000,
    })
    // PII projection: unknown meta keys never cross into the payload.
    const payload = dispatchTrigger.mock.calls[0][0].payload as Record<string, unknown>
    expect(payload.userText).toBeUndefined()
  })

  it("filters by the node's kinds param", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1", { kinds: ["unwell"] })])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    expect(dispatchTrigger).not.toHaveBeenCalled()
    await _injectPetEventForTest(event("unwell"))
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  })

  it("ignores non-lifecycle kinds entirely", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(event("fed"))
    await _injectPetEventForTest(event("thinking"))
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("applies the per-workflow cooldown (default 2000ms)", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    clock += 1000
    await _injectPetEventForTest(event("levelUp", { level: 6 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    clock += 1500 // 2500ms since the first fire
    await _injectPetEventForTest(event("levelUp", { level: 7 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("honors a custom cooldownMs param", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1", { cooldownMs: 0 })])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    await _injectPetEventForTest(event("levelUp", { level: 6 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("isolates a failing dispatch per match", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1"), workflowWithPetTrigger("wf2")])
    dispatchTrigger.mockRejectedValueOnce(new Error("boom"))
    await _injectPetEventForTest(event("evolved", { stage: "juvenile" }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("does nothing after dispose", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    disposePetEventTrigger()
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })
})
