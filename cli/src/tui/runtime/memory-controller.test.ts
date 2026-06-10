/**
 * @jest-environment node
 */
import { memoryList, memoryShow } from "./memory-controller"
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
