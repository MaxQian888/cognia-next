import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractMemories } from "./extractor"

function client(reply: string | (() => Promise<string>)): LlmClient {
  return {
    complete: jest.fn(async () => (typeof reply === "string" ? reply : reply())),
  }
}

const newPair = { userText: "I always use pnpm", assistantText: "Got it." }

describe("extractMemories", () => {
  it("parses memories from a JSON reply and filters by allowTypes", async () => {
    const reply = JSON.stringify({
      memories: [
        { type: "semantic", text: "The user uses pnpm", importance: 7 },
        { type: "procedural", text: "Always use pnpm", importance: 8, key: "pkg-manager" },
      ],
    })
    const out = await extractMemories({ newPair, allowTypes: ["semantic"] }, client(reply))
    expect(out).toEqual([{ type: "semantic", text: "The user uses pnpm", importance: 7 }])
  })

  it("keeps procedural + key when allowed", async () => {
    const reply = JSON.stringify({
      memories: [{ type: "procedural", text: "Always use pnpm", importance: 8, key: "pm" }],
    })
    const out = await extractMemories(
      { newPair, allowTypes: ["semantic", "procedural"] },
      client(reply)
    )
    expect(out[0]).toEqual({
      type: "procedural",
      text: "Always use pnpm",
      importance: 8,
      key: "pm",
    })
  })

  it("tolerates fenced JSON and surrounding prose", async () => {
    const reply =
      'Sure!\n```json\n{"memories":[{"type":"semantic","text":"X","importance":3}]}\n```'
    const out = await extractMemories({ newPair, allowTypes: ["semantic"] }, client(reply))
    expect(out).toHaveLength(1)
  })

  it("clamps importance into 1..10 and rounds", async () => {
    const reply = JSON.stringify({
      memories: [
        { type: "semantic", text: "a", importance: 99 },
        { type: "semantic", text: "b", importance: -3 },
        { type: "semantic", text: "c", importance: 4.6 },
      ],
    })
    const out = await extractMemories({ newPair, allowTypes: ["semantic"] }, client(reply))
    expect(out.map((m) => m.importance)).toEqual([10, 1, 5])
  })

  it("defaults importance to 5 when missing/non-numeric", async () => {
    const reply = JSON.stringify({ memories: [{ type: "semantic", text: "a" }] })
    const out = await extractMemories({ newPair, allowTypes: ["semantic"] }, client(reply))
    expect(out[0].importance).toBe(5)
  })

  it("drops invalid entries (bad type, empty text)", async () => {
    const reply = JSON.stringify({
      memories: [
        { type: "nope", text: "x", importance: 5 },
        { type: "semantic", text: "   ", importance: 5 },
        { type: "semantic", text: "keep", importance: 5 },
      ],
    })
    const out = await extractMemories({ newPair, allowTypes: ["semantic"] }, client(reply))
    expect(out).toEqual([{ type: "semantic", text: "keep", importance: 5 }])
  })

  it("returns [] for empty allowTypes", async () => {
    const out = await extractMemories({ newPair, allowTypes: [] }, client("{}"))
    expect(out).toEqual([])
  })

  it("returns [] when the user text is blank", async () => {
    const out = await extractMemories(
      { newPair: { userText: "  ", assistantText: "x" }, allowTypes: ["semantic"] },
      client("{}")
    )
    expect(out).toEqual([])
  })

  it("returns [] on non-JSON / LLM failure", async () => {
    expect(
      await extractMemories({ newPair, allowTypes: ["semantic"] }, client("not json"))
    ).toEqual([])
    const thrower = client(async () => {
      throw new Error("LLM down")
    })
    expect(await extractMemories({ newPair, allowTypes: ["semantic"] }, thrower)).toEqual([])
  })

  it("includes rolling summary + recent messages in the prompt", async () => {
    const c = client(JSON.stringify({ memories: [] }))
    await extractMemories(
      {
        rollingSummary: "Talked about tooling",
        recentMessages: [{ role: "user", text: "hi" }],
        newPair,
        allowTypes: ["semantic"],
      },
      c
    )
    const prompt = (c.complete as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("Talked about tooling")
    expect(prompt).toContain("user: hi")
    expect(prompt).toContain("Allowed types: semantic")
  })
})
