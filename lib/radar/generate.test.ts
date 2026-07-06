import { normalizeRadarOutput, generateRadarReport } from "./generate"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { RadarDataItem } from "@/types/radar"

describe("normalizeRadarOutput", () => {
  it("fills defaults for a malformed payload", () => {
    const out = normalizeRadarOutput({}, 3)
    expect(out.verdict).toBe("")
    expect(out.atAGlance).toEqual([])
    expect(out.graveyard).toEqual([])
  })

  it("keeps valid fields and filters out-of-range graveyard indices", () => {
    const out = normalizeRadarOutput(
      {
        verdict: "you read a lot of rust",
        atAGlance: ["a", 3, "b"],
        graveyard: [
          { index: 1, reason: "revisit" },
          { index: 99, reason: "out of range" },
          { index: 0 },
        ],
        topicCloud: [{ topic: "rust", weight: 0.7 }, { weight: 1 }],
      },
      3
    )
    expect(out.verdict).toBe("you read a lot of rust")
    expect(out.atAGlance).toEqual(["a", "b"])
    expect(out.graveyard).toEqual([{ index: 1, reason: "revisit" }])
    expect(out.topicCloud).toEqual([{ topic: "rust", weight: 0.7 }])
  })
})

describe("generateRadarReport", () => {
  const items: RadarDataItem[] = [{ id: "a", text: "rust ownership", source: "memory", at: 0 }]

  it("calls the client and parses JSON", async () => {
    const client: LlmClient = {
      complete: jest.fn(async () => '```json\n{"verdict":"ok","actions":["do x"]}\n```'),
    }
    const out = await generateRadarReport(client, { items })
    expect(client.complete).toHaveBeenCalled()
    expect(out.verdict).toBe("ok")
    expect(out.actions).toEqual(["do x"])
  })
})
