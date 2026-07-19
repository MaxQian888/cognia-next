import { resolveMemoryTurnPolicy } from "./policy"
import { DEFAULT_MEMORY_CONFIG } from "@/types/memory/memory"

describe("resolveMemoryTurnPolicy", () => {
  it("separates recall and learning controls", () => {
    expect(
      resolveMemoryTurnPolicy({
        config: { ...DEFAULT_MEMORY_CONFIG, useMemory: false, learnFromChats: true },
      })
    ).toMatchObject({ canRecall: false, canLearn: true, recallReason: "disabled_for_chat" })
  })

  it("lets per-session controls override global defaults", () => {
    expect(
      resolveMemoryTurnPolicy({
        config: { ...DEFAULT_MEMORY_CONFIG, useMemory: false, learnFromChats: false },
        session: { memoryUse: true, memoryLearn: true },
      })
    ).toMatchObject({ canRecall: true, canLearn: true })
  })

  it("maps temporary mode to neither recall nor learning", () => {
    expect(
      resolveMemoryTurnPolicy({
        config: { ...DEFAULT_MEMORY_CONFIG, temporary: true },
      })
    ).toEqual({
      canRecall: false,
      canLearn: false,
      recallReason: "temporary",
      learnReason: "temporary",
    })
  })

  it("blocks automatic learning from external context but still permits recall", () => {
    expect(
      resolveMemoryTurnPolicy({
        config: DEFAULT_MEMORY_CONFIG,
        externalContext: ["web-search", "mcp"],
      })
    ).toMatchObject({
      canRecall: true,
      canLearn: false,
      learnReason: "external_context",
    })
  })

  it("does not treat local code tools as external context", () => {
    expect(
      resolveMemoryTurnPolicy({
        config: DEFAULT_MEMORY_CONFIG,
        externalContext: ["local-tool"],
      })
    ).toMatchObject({ canRecall: true, canLearn: true })
  })
})
