import { makeSaveTopicsNode, SAVE_TOPICS_KIND } from "./save-topics"
import type { PluginDexieAPI } from "@/types/plugin"
import type { StepExecutionContext } from "@/types/workflow/visual"

function fakeDexie() {
  const topics = {
    bulkPut: jest.fn(async (_rows: unknown[]): Promise<void> => undefined),
    toArray: jest.fn(async (): Promise<unknown[]> => []),
  }
  const dexie: PluginDexieAPI = {
    table: jest.fn(() => topics) as unknown as PluginDexieAPI["table"],
    rawDb: jest.fn(),
  }
  return { dexie, topics }
}

function ctxWith(params: Record<string, unknown>): StepExecutionContext {
  return { params, log: jest.fn() } as unknown as StepExecutionContext
}

describe("save-topics node", () => {
  it("is an unprefixed plugin node with a candidates schema and default expression", () => {
    const node = makeSaveTopicsNode(fakeDexie().dexie)
    expect(node.kind).toBe(SAVE_TOPICS_KIND)
    expect(node.category).toBe("plugin")
    expect(node.retryable).toBe(false)
    expect((node.paramsSchema as { required: string[] }).required).toContain("candidates")
    expect(node.defaultParams?.candidates).toBe("{{ $node['rank'].completion }}")
  })

  it("parses candidates and persists them, returning ids", async () => {
    const { dexie, topics } = fakeDexie()
    const node = makeSaveTopicsNode(dexie)
    const result = await node.execute(
      ctxWith({ candidates: '[{"title":"A"},{"title":"B"}]', source: "zhihu-hot" })
    )
    const out = result.output as { saved: number; topicIds: string[] }
    expect(out.saved).toBe(2)
    expect(out.topicIds).toHaveLength(2)
    expect(topics.bulkPut).toHaveBeenCalledTimes(1)
  })

  it("no-ops (saved 0) and warns when nothing parses", async () => {
    const { dexie, topics } = fakeDexie()
    const ctx = ctxWith({ candidates: "not json" })
    const result = await makeSaveTopicsNode(dexie).execute(ctx)
    expect((result.output as { saved: number }).saved).toBe(0)
    expect(topics.bulkPut).not.toHaveBeenCalled()
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("no candidates"))
  })

  it("defaults the source label when omitted or blank", async () => {
    const { dexie, topics } = fakeDexie()
    const node = makeSaveTopicsNode(dexie)
    await node.execute(ctxWith({ candidates: [{ title: "A" }] }))
    await node.execute(ctxWith({ candidates: [{ title: "B" }], source: "   " }))
    const first = topics.bulkPut.mock.calls[0][0] as Array<{ source: string }>
    const second = topics.bulkPut.mock.calls[1][0] as Array<{ source: string }>
    expect(first[0].source).toBe("pipeline")
    expect(second[0].source).toBe("pipeline")
  })

  it("tolerates a missing params object", async () => {
    const { dexie } = fakeDexie()
    const result = await makeSaveTopicsNode(dexie).execute({ log: jest.fn() } as never)
    expect((result.output as { saved: number }).saved).toBe(0)
  })
})
