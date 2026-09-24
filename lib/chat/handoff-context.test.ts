import type { UIMessage } from "ai"
import { buildHandoffContext, prepareHandoffContext } from "./handoff-context"

const message = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})

describe("handoff context", () => {
  it("retains a complete derived summary including its final constraint", async () => {
    const summary = "Evidence: ".repeat(45) + "Never deploy without user approval."
    const result = await prepareHandoffContext([message("large", "history ".repeat(1000))], {
      maxChars: 1000,
      state: { oldEvents: "event ".repeat(500) },
      client: { complete: jest.fn().mockResolvedValue(summary) },
    })
    expect(result.text).toContain(summary)
    expect(result.text.length).toBeLessThanOrEqual(1000)
  })

  it("refuses a live handoff when even the complete derived summary exceeds its budget", async () => {
    await expect(
      prepareHandoffContext([message("large", "history ".repeat(1000))], {
        maxChars: 500,
        client: { complete: jest.fn().mockResolvedValue("critical constraint ".repeat(100)) },
      })
    ).rejects.toThrow("handoff_context_summary_exceeds_budget")
  })

  it("preserves constraints, multiline evidence and tool identities without private reasoning", () => {
    const result = buildHandoffContext([
      message("goal", "Only investigate. Do not edit files."),
      {
        id: "evidence",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private thought" },
          {
            type: "dynamic-tool",
            toolName: "test",
            toolCallId: "call-1",
            state: "output-available",
            input: { command: "pnpm test" },
            output: "FAILED\n" + "evidence".repeat(80),
          },
        ],
      },
    ])
    expect(result.text).toContain("Only investigate. Do not edit files.")
    expect(result.text).toContain("evidence".repeat(80))
    expect(result.text).toContain("FAILED\n")
    expect(result.text).toContain("call-1")
    expect(result.text).toContain("output-available")
    expect(result.text).not.toContain("private thought")
    expect(result.text).toContain("evidence")
    expect(result.omittedMessageIds).toEqual([])
  })

  it("keeps the original goal and recent whole messages with an explicit budget loss", () => {
    const result = buildHandoffContext(
      [
        message("goal", "Never modify production"),
        message("large", "old material ".repeat(100)),
        message("recent", "Next: inspect the failing assertion"),
      ],
      { maxChars: 700 }
    )
    expect(result.text.length).toBeLessThanOrEqual(700)
    expect(result.text).toContain("Never modify production")
    expect(result.text).toContain("Next: inspect the failing assertion")
    expect(result.omittedMessageIds).toEqual(["large"])
    expect(result.text).toContain("omitted")
    expect(result.losses).toContainEqual(
      expect.objectContaining({ messageId: "large", kind: "budget" })
    )
  })

  it("reports nonportable attachments and unknown content instead of pretending they transferred", () => {
    const result = buildHandoffContext([
      {
        id: "files",
        role: "user",
        parts: [
          { type: "file", filename: "trace.txt", mediaType: "text/plain", url: "blob:local" },
          { type: "data-widget", data: { status: "waiting" } },
        ],
      },
    ])
    expect(result.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "attachment", messageId: "files" }),
        expect.objectContaining({ kind: "unsupported", messageId: "files" }),
      ])
    )
    expect(result.text).toContain("trace.txt")
    expect(result.text).toContain("not transferred")
  })

  it("includes historical task state as data, never as approval to execute", () => {
    const result = buildHandoffContext([], {
      state: { goals: ["Fix parser"], tasks: [{ status: "pending", title: "Add regression" }] },
    })
    expect(result.text).toContain("Fix parser")
    expect(result.text).toContain("Add regression")
    expect(result.text).toContain("not authorization")
  })

  it("uses the gated summarizer on all oversized material and marks the summary as derived", async () => {
    const complete = jest
      .fn()
      .mockResolvedValue("Goal: do not edit production. Evidence: test failed. Next: inspect.")
    const result = await prepareHandoffContext(
      [
        message("first", "do not edit production"),
        message("long", "material ".repeat(4000)),
        message("last", "inspect"),
      ],
      { maxChars: 900, client: { complete } }
    )
    expect(complete).toHaveBeenCalled()
    expect(result.text).toContain("Derived summary")
    expect(result.text).toContain("do not edit production")
    expect(result.text.length).toBeLessThanOrEqual(900)
  })

  it("refuses silent context loss when a large live handoff cannot be summarized", async () => {
    await expect(
      prepareHandoffContext([message("long", "context ".repeat(1000))], {
        maxChars: 500,
        client: null,
      })
    ).rejects.toThrow("handoff_context_summary_unavailable")
  })

  it("summarizes oversized task state even when every message fits", async () => {
    const complete = jest.fn().mockResolvedValue("Task constraint: preserve the original fixtures.")
    const result = await prepareHandoffContext([message("recent", "Continue")], {
      maxChars: 1200,
      state: { constraints: "preserve the original fixtures. ".repeat(200) },
      client: { complete },
    })
    expect(complete).toHaveBeenCalled()
    expect(result.text).toContain("Derived summary")
    expect(result.text).toContain("Task constraint: preserve the original fixtures.")
  })
})
