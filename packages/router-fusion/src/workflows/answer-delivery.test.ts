import type { RunResult } from "../contracts/schemas"
import { answerChunks, answerDeliveryEvents } from "./answer-delivery"

function result(answer: string): RunResult {
  return {
    answer,
    answer_artifact_id: "11111111-1111-4111-8111-111111111111",
    answer_sha256: "a".repeat(64),
    mode_executed: "panel",
    quality_status: "accepted",
    verification: {
      schema_version: "1.0.0",
      report_id: "22222222-2222-4222-8222-222222222222",
      status: "passed",
      level: "mixed",
      checks: [],
      revision: null,
      verifier_version: "v",
      artifact_refs: [],
    },
    delivery: "answer",
    artifact_ids: [],
    warnings: [],
  }
}

describe("answerChunks", () => {
  it("covers the whole answer in UTF-8 byte ranges that never split a character", () => {
    const text = "价格上涨了4%。".repeat(7) + "🙂 done"
    const chunks = answerChunks(text, 5)
    const bytes = new TextEncoder().encode(text)
    expect(chunks[0].offset).toBe(0)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].offset).toBe(chunks[i - 1].offset + chunks[i - 1].length)
    }
    const last = chunks.at(-1)!
    expect(last.offset + last.length).toBe(bytes.byteLength)
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const rebuilt = chunks
      .map((c) => decoder.decode(bytes.slice(c.offset, c.offset + c.length)))
      .join("")
    expect(rebuilt).toBe(text)
  })

  it("has nothing to deliver for an empty answer", () => {
    expect(answerChunks("")).toEqual([])
  })
})

describe("answerDeliveryEvents", () => {
  it("[ACC:SSE-02] names byte ranges of the verified answer and never carries its text", () => {
    const answer = "The verified synthesis. ".repeat(200)
    const events = answerDeliveryEvents(
      result(answer),
      "33333333-3333-4333-8333-333333333333",
      1000
    )
    const deltas = events.filter((e) => e.type === "answer.delta")
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((e) => e.payload.index)).toEqual(deltas.map((_, i) => i))
    expect(events.at(-1)).toEqual({
      type: "answer.completed",
      payload: {
        answer_artifact_id: "11111111-1111-4111-8111-111111111111",
        answer_sha256: "a".repeat(64),
        result_artifact_id: "33333333-3333-4333-8333-333333333333",
        chunks: deltas.length,
        mode_executed: "panel",
        quality_status: "accepted",
        verification_status: "passed",
        verification_level: "mixed",
      },
    })
    expect(JSON.stringify(events)).not.toContain("verified synthesis")
  })
})
