import { generateTurnLabel, MAX_LABEL_LENGTH } from "./turn-label"
import type { LlmClient } from "@/lib/twin/distill/llm"

function mockClient(impl: (prompt: string) => Promise<string> | string): LlmClient {
  return { complete: jest.fn(async (p: string) => impl(p)) }
}

describe("generateTurnLabel", () => {
  it("returns empty when there is no user text", async () => {
    const client = mockClient(() => "Label")
    expect(await generateTurnLabel(client, { userText: "" })).toBe("")
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("sanitises and clamps the label", async () => {
    const client = mockClient(() => '"Refactor the whole message list rendering pipeline now"')
    const out = await generateTurnLabel(client, { userText: "do a big refactor" })
    expect(out.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH)
    expect(out.startsWith('"')).toBe(false)
  })

  it("passes the locale hint into the prompt", async () => {
    const client = mockClient(() => "x")
    await generateTurnLabel(client, { userText: "hi", locale: "zh-CN" })
    const prompt = (client.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("zh-CN")
  })

  it("returns empty when the client throws", async () => {
    const client: LlmClient = {
      complete: jest.fn(async () => {
        throw new Error("boom")
      }),
    }
    expect(await generateTurnLabel(client, { userText: "hi" })).toBe("")
  })
})
