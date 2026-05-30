import { generateConversationTitle, sanitizeTitle, MAX_TITLE_LENGTH } from "./title"
import type { LlmClient } from "@/lib/twin/distill/llm"

function mockClient(impl: (prompt: string) => Promise<string> | string): LlmClient {
  return { complete: jest.fn(async (p: string) => impl(p)) }
}

describe("sanitizeTitle", () => {
  it("returns empty for empty input", () => {
    expect(sanitizeTitle("")).toBe("")
    expect(sanitizeTitle("   ")).toBe("")
  })

  it("takes the first non-empty line", () => {
    expect(sanitizeTitle("\n\nRefactor the message list\nmore text")).toBe(
      "Refactor the message list"
    )
  })

  it("strips a leading Title: label (en + zh)", () => {
    expect(sanitizeTitle("Title: Fix the bug")).toBe("Fix the bug")
    expect(sanitizeTitle("标题：修复报错")).toBe("修复报错")
  })

  it("strips wrapping quotes and markdown", () => {
    expect(sanitizeTitle('"Add tests"')).toBe("Add tests")
    expect(sanitizeTitle("**Add tests**")).toBe("Add tests")
    expect(sanitizeTitle("“智能标题”")).toBe("智能标题")
  })

  it("drops trailing sentence punctuation", () => {
    expect(sanitizeTitle("Set up CI.")).toBe("Set up CI")
    expect(sanitizeTitle("配置好了。")).toBe("配置好了")
  })

  it("clamps to the max length", () => {
    const long = "word ".repeat(40)
    expect(sanitizeTitle(long).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
  })
})

describe("generateConversationTitle", () => {
  it("returns empty when there is no user text", async () => {
    const client = mockClient(() => "Anything")
    expect(await generateConversationTitle(client, { firstUserText: "  " })).toBe("")
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("sanitises the model output", async () => {
    const client = mockClient(() => '"Refactor message list"\n')
    const out = await generateConversationTitle(client, {
      firstUserText: "help me refactor the message list",
      firstAssistantText: "Sure, here is how.",
      locale: "en",
    })
    expect(out).toBe("Refactor message list")
  })

  it("includes the assistant reply and locale in the prompt", async () => {
    const client = mockClient(() => "T")
    await generateConversationTitle(client, {
      firstUserText: "question",
      firstAssistantText: "answer body",
      locale: "zh-CN",
    })
    const prompt = (client.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("answer body")
    expect(prompt).toContain("zh-CN")
  })

  it("returns empty when the client throws", async () => {
    const client: LlmClient = {
      complete: jest.fn(async () => {
        throw new Error("boom")
      }),
    }
    expect(await generateConversationTitle(client, { firstUserText: "hi" })).toBe("")
  })
})
