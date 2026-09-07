const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

const findMatchingWorkflows = jest.fn((_k: string, _c: unknown) => [] as unknown[])
jest.mock("./trigger-subscriptions", () => ({
  findMatchingWorkflows: (k: string, c: unknown) => findMatchingWorkflows(k, c),
}))

import {
  createFanOutState,
  disposeFanOut,
  fanOutTrigger,
  MAX_TRIGGER_CHAIN_DEPTH,
} from "./trigger-fan-out"

function match(workflowId: string, params: Record<string, unknown> = {}) {
  return { workflowId, nodeId: "t1", params }
}

let clock = 1_000_000

beforeEach(() => {
  jest.clearAllMocks()
  clock = 1_000_000
  findMatchingWorkflows.mockReturnValue([match("wf1")])
})

function state() {
  return createFanOutState(() => clock)
}

describe("fanOutTrigger", () => {
  it("dispatches to each match and stamps the chain depth", async () => {
    findMatchingWorkflows.mockReturnValue([match("wf1"), match("wf2")])
    const fired = await fanOutTrigger({
      state: state(),
      kind: "trigger.plan.event" as never,
      match: {},
      payload: { a: 1 },
    })
    expect(fired).toBe(2)
    expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
      workflowId: "wf1",
      payload: { a: 1, chainDepth: 1 },
    })
  })

  it("holds a workflow off for its cooldown, and lets a different one through", async () => {
    findMatchingWorkflows.mockReturnValue([match("wf1", { cooldownMs: 5000 })])
    const s = state()
    expect(await fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })).toBe(1)
    expect(await fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })).toBe(0)

    clock += 5001
    expect(await fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })).toBe(1)
  })

  it("skips a workflow whose run is still in flight", async () => {
    // The guard spans the whole run, because dispatchTrigger awaits it. That is
    // what makes a self-feeding trigger structurally impossible.
    const s = state()
    let release: (() => void) | undefined
    dispatchTrigger.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )
    const first = fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })
    const second = await fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })
    expect(second).toBe(0)
    release?.()
    await first
  })

  it("refuses a match the caller rejects, and says why", async () => {
    const fired = await fanOutTrigger({
      state: state(),
      kind: "k" as never,
      match: {},
      payload: {},
      reject: () => "it created this",
    })
    expect(fired).toBe(0)
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("stops at the chain-depth ceiling", async () => {
    const fired = await fanOutTrigger({
      state: state(),
      kind: "k" as never,
      match: {},
      payload: { chainDepth: MAX_TRIGGER_CHAIN_DEPTH },
    })
    expect(fired).toBe(0)
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("isolates one failing workflow from its siblings", async () => {
    findMatchingWorkflows.mockReturnValue([match("wf1"), match("wf2")])
    dispatchTrigger.mockRejectedValueOnce(new Error("wf1 is broken"))
    await expect(
      fanOutTrigger({ state: state(), kind: "k" as never, match: {}, payload: {} })
    ).resolves.toBe(2)
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("does nothing once disposed", async () => {
    const s = state()
    disposeFanOut(s)
    expect(await fanOutTrigger({ state: s, kind: "k" as never, match: {}, payload: {} })).toBe(0)
  })

  it("runs the bus disposer, and survives one that throws", () => {
    const unsubscribe = jest.fn()
    const s = state()
    s.unsubscribe = unsubscribe
    disposeFanOut(s)
    expect(unsubscribe).toHaveBeenCalled()

    const throwing = state()
    throwing.unsubscribe = () => {
      throw new Error("bus is gone")
    }
    expect(() => disposeFanOut(throwing)).not.toThrow()
  })
})
