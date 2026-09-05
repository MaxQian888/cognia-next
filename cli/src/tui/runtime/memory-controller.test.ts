/**
 * @jest-environment node
 */
import { memoryAdd, memoryDelete, memoryList, memoryShow } from "./memory-controller"
import type { Memory } from "@/types/memory/memory"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const mem = (id: string, text: string, type = "semantic"): Memory =>
  ({ id, text, type, tags: [], importance: 5 }) as unknown as Memory

const msg = (a: TuiAction) => (a as unknown as { message: string }).message

describe("memoryList", () => {
  it("reports the real recall mode rather than asserting desktop-only", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({
      dispatch,
      ensureDb: async () => {},
      list: async () => [mem("m1", "likes dark mode")],
      describeMode: async () => ({ kind: "bm25", reason: "no_backend" }),
    })
    expect(msg(actions[0]!)).toContain("keyword-only")
    expect(msg(actions[0]!)).toContain("no embedding or vector backend")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "select", onSelectCommand: "memory show", items: [{ id: "m1" }] },
    })
  })

  it("says so when hybrid recall is actually available", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({
      dispatch,
      ensureDb: async () => {},
      list: async () => [mem("m1", "x")],
      describeMode: async () => ({ kind: "hybrid", provider: "openai" }),
    })
    expect(msg(actions[0]!)).toContain("Hybrid recall is available via openai")
  })

  it("does not invent a recall mode when the probe fails", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({
      dispatch,
      ensureDb: async () => {},
      list: async () => [mem("m1", "x")],
      describeMode: async () => {
        throw new Error("probe failed")
      },
    })
    expect(msg(actions[0]!)).toContain("Could not determine recall mode")
  })

  it("notices when no memories are stored", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({ dispatch, ensureDb: async () => {}, list: async () => [] })
    expect(actions).toHaveLength(1)
    expect(msg(actions[0]!)).toContain("No memories")
  })
})

describe("memoryShow", () => {
  it("notices the full memory text + type", async () => {
    const { dispatch, actions } = recorder()
    await memoryShow("m1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => mem("m1", "likes dark mode", "semantic"),
    })
    expect(msg(actions[0]!)).toBe("[semantic] likes dark mode")
  })

  it("notices a missing memory", async () => {
    const { dispatch, actions } = recorder()
    await memoryShow("x", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect(msg(actions[0]!)).toContain("not found")
  })
})

describe("memoryAdd", () => {
  it("saves a memory through the canonical funnel and confirms", async () => {
    const { dispatch, actions } = recorder()
    const add = jest.fn(async () => ({ ok: true, scope: "global" }) as const)
    await memoryAdd("  always use pnpm  ", { dispatch, ensureDb: async () => {}, add })
    expect(add).toHaveBeenCalledWith("always use pnpm")
    expect(msg(actions[0]!)).toContain("Remembered")
  })

  it("rejects an empty memory", async () => {
    const { dispatch, actions } = recorder()
    const add = jest.fn()
    await memoryAdd("   ", { dispatch, ensureDb: async () => {}, add })
    expect(add).not.toHaveBeenCalled()
    expect(msg(actions[0]!)).toContain("Usage: /remember")
  })

  // The gate the CLI never had: a refusal must be reported, not swallowed into
  // a "Remembered" that never happened.
  it.each([
    ["pii", "sensitive data"],
    ["denied", "not allowed"],
    ["disabled", "turned off"],
    ["temporary", "Temporary mode"],
    ["failed", "went wrong"],
  ])("reports the %s refusal instead of confirming", async (reason, copy) => {
    const { dispatch, actions } = recorder()
    const add = jest.fn(async () => ({ ok: false, reason }) as never)
    await memoryAdd("fact", { dispatch, ensureDb: async () => {}, add })
    expect(msg(actions[0]!)).toContain(copy)
    expect(msg(actions[0]!)).not.toContain("Remembered")
  })
})

describe("memoryDelete", () => {
  it("deletes through the audited control plane", async () => {
    const { dispatch, actions } = recorder()
    const remove = jest.fn(async () => ({ ok: true }))
    await memoryDelete("m1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => mem("m1", "x"),
      remove,
    })
    expect(remove).toHaveBeenCalledWith("m1")
    expect(msg(actions[0]!)).toContain("Deleted memory m1")
  })

  it("reports a refused delete instead of claiming success", async () => {
    const { dispatch, actions } = recorder()
    const remove = jest.fn(async () => ({ ok: false, reason: "policy_denied" }))
    await memoryDelete("m1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => mem("m1", "x"),
      remove,
    })
    expect(msg(actions[0]!)).toContain("policy_denied")
    expect(msg(actions[0]!)).not.toContain("Deleted memory")
  })

  it("notices a missing memory without deleting", async () => {
    const { dispatch, actions } = recorder()
    const remove = jest.fn()
    await memoryDelete("gone", {
      dispatch,
      ensureDb: async () => {},
      get: async () => undefined,
      remove,
    })
    expect(remove).not.toHaveBeenCalled()
    expect(msg(actions[0]!)).toContain("not found")
  })

  it("rejects an empty id", async () => {
    const { dispatch, actions } = recorder()
    await memoryDelete("  ", { dispatch, ensureDb: async () => {} })
    expect(msg(actions[0]!)).toContain("Usage: /memory delete")
  })
})

it("does not write memory after cancellation during database initialization", async () => {
  const controller = new AbortController()
  const { dispatch, actions } = recorder()
  const add = jest.fn()
  await memoryAdd("fact", {
    dispatch,
    signal: controller.signal,
    ensureDb: async () => {
      controller.abort()
    },
    add,
  })
  expect(add).not.toHaveBeenCalled()
  expect(actions).toEqual([])
})
