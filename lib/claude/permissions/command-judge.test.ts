import { judgeCommandSafety, __resetJudgeCache } from "./command-judge"
import type { LlmClient } from "@/lib/twin/distill/llm"

function mockClient(response: string): LlmClient & { complete: jest.Mock } {
  const complete = jest.fn(async () => response)
  return { complete } as unknown as LlmClient & { complete: jest.Mock }
}

beforeEach(() => __resetJudgeCache())

describe("judgeCommandSafety", () => {
  it("parses a safe verdict", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "reads a file"}')
    const out = await judgeCommandSafety(client, "cat foo.txt")
    expect(out).toEqual({ safe: true, risk: "low", reason: "reads a file" })
  })

  it("parses an unsafe verdict and clamps an unknown risk", async () => {
    const client = mockClient('{"safe": false, "risk": "catastrophic", "reason": "wipes disk"}')
    const out = await judgeCommandSafety(client, "rm -rf /")
    expect(out?.safe).toBe(false)
    expect(out?.risk).toBe("high")
  })

  it("extracts JSON wrapped in prose / fences", async () => {
    const client = mockClient(
      'Sure!\n```json\n{"safe": false, "risk": "medium", "reason": "x"}\n```'
    )
    const out = await judgeCommandSafety(client, "git push")
    expect(out).toEqual({ safe: false, risk: "medium", reason: "x" })
  })

  it("returns null and does NOT call the model when the command leaks PII", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "x"}')
    const out = await judgeCommandSafety(client, "git config user.email me@example.com")
    expect(out).toBeNull()
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("returns null on malformed model output", async () => {
    const client = mockClient("not json at all")
    expect(await judgeCommandSafety(client, "ls")).toBeNull()
  })

  it("returns null when the model call throws", async () => {
    const client = {
      complete: jest.fn(async () => {
        throw new Error("boom")
      }),
    } as unknown as LlmClient
    expect(await judgeCommandSafety(client, "ls")).toBeNull()
  })

  it("returns null for an empty command without calling the model", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "x"}')
    expect(await judgeCommandSafety(client, "   ")).toBeNull()
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("caches by command so the model is queried once", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test")
    await judgeCommandSafety(client, "npm test")
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("defaults a missing risk to high when unsafe", async () => {
    const client = mockClient('{"safe": false, "reason": "no risk field"}')
    const out = await judgeCommandSafety(client, "weird")
    expect(out?.risk).toBe("high")
  })
})
