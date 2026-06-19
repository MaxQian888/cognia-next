import { traceToPromptText, MAX_PROMPT_STEPS } from "./trace-to-prompt"
import type { ElementInfo } from "@/lib/automation/types"
import type { Observation, RecordingTrace } from "./types"

function el(partial: Partial<ElementInfo>): ElementInfo {
  return partial as unknown as ElementInfo
}

function trace(observations: Observation[]): RecordingTrace {
  return { sessionId: "s", startedAt: 0, endedAt: 1, observations, monitors: [] }
}

describe("traceToPromptText", () => {
  it("describes a click with element + coordinates", () => {
    const text = traceToPromptText(
      trace([
        {
          seq: 1,
          tsMs: 0,
          kind: "click",
          point: { x: 120, y: 340 },
          element: el({ name: "Save", controlType: "Button", automationId: "saveBtn" }),
        },
      ])
    )
    expect(text).toContain('1. click "Save" Button #saveBtn at (120, 340)')
  })

  it("describes a typed run via the text hint", () => {
    const text = traceToPromptText(
      trace([
        {
          seq: 1,
          tsMs: 0,
          kind: "key",
          textHint: "HELLO",
          element: el({ name: "Email", controlType: "Edit" }),
        },
      ])
    )
    expect(text).toContain('type "HELLO" into "Email" Edit')
  })

  it("describes scroll direction", () => {
    const down = traceToPromptText(trace([{ seq: 1, tsMs: 0, kind: "scroll", scrollDy: -200 }]))
    expect(down).toContain("scroll down")
    const up = traceToPromptText(trace([{ seq: 1, tsMs: 0, kind: "scroll", scrollDy: 200 }]))
    expect(up).toContain("scroll up")
  })

  it("emits a window header when the active window changes", () => {
    const text = traceToPromptText(
      trace([
        { seq: 1, tsMs: 0, kind: "click", element: el({ windowTitle: "Editor" }) },
        { seq: 2, tsMs: 1, kind: "click", element: el({ windowTitle: "Editor" }) },
        { seq: 3, tsMs: 2, kind: "click", element: el({ windowTitle: "Browser" }) },
      ])
    )
    // Two distinct windows → two headers, not three.
    expect(text.match(/# Window:/g)?.length).toBe(2)
    expect(text).toContain("# Window: Editor")
    expect(text).toContain("# Window: Browser")
  })

  it("never inlines screenshot bytes", () => {
    const text = traceToPromptText(
      trace([
        {
          seq: 1,
          tsMs: 0,
          kind: "click",
          screenshot: {
            kind: "inline",
            shot: { bytes: "SECRETBASE64", width: 1, height: 1, capturedAt: 0, format: "png" },
          },
        },
      ])
    )
    expect(text).not.toContain("SECRETBASE64")
  })

  it("falls back to the raw kind for an unknown step kind", () => {
    const text = traceToPromptText(trace([{ seq: 1, tsMs: 0, kind: "hover" as never }]))
    expect(text).toContain("1. hover")
  })

  it("caps the number of serialized steps", () => {
    const many: Observation[] = Array.from({ length: MAX_PROMPT_STEPS + 5 }, (_, i) => ({
      seq: i + 1,
      tsMs: i,
      kind: "click" as const,
    }))
    const text = traceToPromptText(trace(many))
    expect(text).toContain("more steps omitted")
  })
})
