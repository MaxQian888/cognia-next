import { generateSkillFromTrace } from "./generate-from-trace"
import type { ElementInfo } from "@/lib/automation/types"
import type { Observation, RecordingTrace } from "./recording/types"

function el(partial: Partial<ElementInfo>): ElementInfo {
  return partial as unknown as ElementInfo
}

function trace(observations: Observation[]): RecordingTrace {
  return { sessionId: "s", startedAt: 0, endedAt: 1, observations, monitors: [] }
}

const VALID_JSON = JSON.stringify({
  name: "Export the report",
  description: "Export a report to CSV",
  content: "## When to use\nWhen exporting.\n## Steps\n1. Click export",
  tags: ["export", "csv"],
  category: "productivity",
  allowedTools: [],
})

function mockClient(response: string) {
  return { complete: jest.fn().mockResolvedValue(response) }
}

const sampleTrace = trace([
  {
    seq: 1,
    tsMs: 0,
    kind: "click",
    point: { x: 1, y: 2 },
    element: el({ name: "Export", controlType: "Button" }),
  },
])

describe("generateSkillFromTrace", () => {
  it("parses a clean JSON response into a draft", async () => {
    const client = mockClient(VALID_JSON)
    const { draft } = await generateSkillFromTrace(sampleTrace, client)
    expect(draft.name).toBe("Export the report")
    expect(draft.category).toBe("productivity")
    expect(draft.tags).toEqual(["export", "csv"])
  })

  it("strips markdown fences around the JSON", async () => {
    const client = mockClient("```json\n" + VALID_JSON + "\n```")
    const { draft } = await generateSkillFromTrace(sampleTrace, client)
    expect(draft.name).toBe("Export the report")
  })

  it("extracts a JSON object embedded in prose", async () => {
    const client = mockClient("Here is your skill:\n" + VALID_JSON + "\nHope that helps!")
    const { draft } = await generateSkillFromTrace(sampleTrace, client)
    expect(draft.description).toBe("Export a report to CSV")
  })

  it("falls back to the custom category for an unknown value", async () => {
    const client = mockClient(JSON.stringify({ content: "## Steps\n1. x", category: "nonsense" }))
    const { draft } = await generateSkillFromTrace(sampleTrace, client)
    expect(draft.category).toBe("custom")
  })

  it("sanitizes an illegal name", async () => {
    const client = mockClient(
      JSON.stringify({ name: "Save & Export!!!", content: "## Steps\n1. x" })
    )
    const { draft } = await generateSkillFromTrace(sampleTrace, client)
    expect(draft.name).toBe("Save Export")
  })

  it("throws on a response with no content", async () => {
    const client = mockClient(JSON.stringify({ name: "X" }))
    await expect(generateSkillFromTrace(sampleTrace, client)).rejects.toThrow(/no content/)
  })

  it("throws on an empty trace", async () => {
    const client = mockClient(VALID_JSON)
    await expect(generateSkillFromTrace(trace([]), client)).rejects.toThrow(/No steps/)
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("redacts PII before the model call and flags it", async () => {
    const client = mockClient(VALID_JSON)
    const piiTrace = trace([{ seq: 1, tsMs: 0, kind: "key", textHint: "user@example.com" }])
    const { redacted } = await generateSkillFromTrace(piiTrace, client)
    expect(redacted).toBe(true)
    const sentPrompt = client.complete.mock.calls[0][0] as string
    expect(sentPrompt).not.toContain("user@example.com")
  })

  it("does not flag redaction for clean text", async () => {
    const client = mockClient(VALID_JSON)
    const { redacted } = await generateSkillFromTrace(sampleTrace, client)
    expect(redacted).toBe(false)
  })
})
