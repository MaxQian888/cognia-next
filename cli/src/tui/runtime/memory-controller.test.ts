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

describe("memoryList", () => {
  it("notes the RAG limitation then opens a select overlay of stored memories", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({
      dispatch,
      ensureDb: async () => {},
      list: async () => [mem("m1", "likes dark mode")],
    })
    expect((actions[0] as { message: string }).message).toContain("desktop-only")
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "select", onSelectCommand: "memory show", items: [{ id: "m1" }] },
    })
  })

  it("notices when no memories are stored", async () => {
    const { dispatch, actions } = recorder()
    await memoryList({ dispatch, ensureDb: async () => {}, list: async () => [] })
    expect(actions).toHaveLength(1)
    expect((actions[0] as { message: string }).message).toContain("No memories")
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
    expect((actions[0] as { message: string }).message).toBe("[semantic] likes dark mode")
  })

  it("notices a missing memory", async () => {
    const { dispatch, actions } = recorder()
    await memoryShow("x", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("memoryAdd", () => {
  it("saves a memory and confirms", async () => {
    const { dispatch, actions } = recorder()
    const add = jest.fn(async (text: string) => mem("m9", text))
    await memoryAdd("  always use pnpm  ", { dispatch, ensureDb: async () => {}, add })
    expect(add).toHaveBeenCalledWith("always use pnpm")
    expect((actions[0] as { message: string }).message).toContain("Remembered")
  })

  it("rejects an empty memory", async () => {
    const { dispatch, actions } = recorder()
    const add = jest.fn()
    await memoryAdd("   ", { dispatch, ensureDb: async () => {}, add })
    expect(add).not.toHaveBeenCalled()
    expect((actions[0] as { message: string }).message).toContain("Usage: /remember")
  })
})

describe("memoryDelete", () => {
  it("deletes an existing memory", async () => {
    const { dispatch, actions } = recorder()
    const remove = jest.fn(async () => {})
    await memoryDelete("m1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => mem("m1", "x"),
      remove,
    })
    expect(remove).toHaveBeenCalledWith("m1")
    expect((actions[0] as { message: string }).message).toContain("Deleted memory m1")
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
    expect((actions[0] as { message: string }).message).toContain("not found")
  })

  it("rejects an empty id", async () => {
    const { dispatch, actions } = recorder()
    await memoryDelete("  ", { dispatch, ensureDb: async () => {} })
    expect((actions[0] as { message: string }).message).toContain("Usage: /memory delete")
  })
})
