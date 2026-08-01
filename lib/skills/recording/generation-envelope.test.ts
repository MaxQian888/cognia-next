import {
  buildGenerationEnvelope,
  MAX_ENVELOPE_STEPS,
  type EnvelopeOptions,
} from "./generation-envelope"
import type { InputVariable } from "./input-variables"
import type { RecordedStepView } from "./step-model"
import type { RecordedStep, TextCapture } from "./types"

const CATEGORY_IDS = "custom | productivity"

function captured(seq: number, patch: Partial<RecordedStep> = {}): RecordedStep {
  return {
    seq,
    tsMs: seq,
    kind: "click",
    element: { name: `Button ${seq}` },
    ...patch,
  }
}

function view(seq: number, patch: Partial<RecordedStepView> = {}): RecordedStepView {
  return {
    seq,
    captured: captured(seq),
    manual: false,
    excluded: false,
    intent: null,
    verify: null,
    screenshotSelected: false,
    needsIntent: false,
    ...patch,
  }
}

function options(patch: Partial<EnvelopeOptions> = {}): EnvelopeOptions {
  return { variables: [], locale: "en", toolCatalog: ["Read", "Bash"], ...patch }
}

describe("what leaves the device", () => {
  it("omits excluded steps entirely", () => {
    const steps = [
      view(1),
      view(2, { excluded: true, captured: captured(2, { element: { name: "SECRET BUTTON" } }) }),
      view(3),
    ]
    const envelope = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(envelope.userPrompt).not.toContain("SECRET BUTTON")
    expect(envelope.describedSteps).toBe(2)
  })

  it("never carries a screenshot, an asset id, or a coordinate", () => {
    const steps = [
      view(1, {
        captured: captured(1, {
          assetId: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01",
          assetMeta: {
            width: 10,
            height: 10,
            byteLen: 99,
            format: "Png",
            capturedAt: 0,
          },
          point: { x: 412, y: 908 },
        }),
      }),
    ]
    const envelope = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(envelope.userPrompt).not.toContain("0191b0e2")
    expect(envelope.userPrompt).not.toContain("412")
    expect(envelope.userPrompt).not.toContain("908")
    expect(envelope.userPrompt).not.toContain("base64")
  })

  it("describes a secret value without its length or shape", () => {
    const short: TextCapture = { kind: "sensitive" }
    const oneChar = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { kind: "type", text: short }) })],
      options(),
      CATEGORY_IDS
    )
    const manyChars = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { kind: "type", text: short }) })],
      options(),
      CATEGORY_IDS
    )
    expect(oneChar.userPrompt).toBe(manyChars.userPrompt)
    expect(oneChar.userPrompt).not.toMatch(/\d+ characters/)
  })

  it("sends a placeholder instead of a recorded sample for a confirmed variable", () => {
    const variables: InputVariable[] = [
      {
        name: "search_term",
        kind: "variable",
        seq: 1,
        sample: "my-private-query",
        confirmed: true,
      },
    ]
    const steps = [
      view(1, {
        captured: captured(1, {
          kind: "type",
          text: { kind: "text", value: "my-private-query" },
        }),
      }),
    ]
    const envelope = buildGenerationEnvelope(steps, options({ variables }), CATEGORY_IDS)
    expect(envelope.userPrompt).not.toContain("my-private-query")
    expect(envelope.userPrompt).toContain("{{search_term}}")
  })

  it("keeps a value the user marked as a fixed literal", () => {
    const variables: InputVariable[] = [
      { name: "menu", kind: "literal", seq: 1, sample: "File", confirmed: true },
    ]
    const steps = [
      view(1, { captured: captured(1, { kind: "type", text: { kind: "text", value: "File" } }) }),
    ]
    const envelope = buildGenerationEnvelope(steps, options({ variables }), CATEGORY_IDS)
    expect(envelope.userPrompt).toContain("File")
  })

  it("lists a secret input by name only", () => {
    const variables: InputVariable[] = [
      { name: "password", kind: "sensitive", seq: 1, confirmed: true },
    ]
    const envelope = buildGenerationEnvelope([view(1)], options({ variables }), CATEGORY_IDS)
    expect(envelope.userPrompt).toContain("{{password}}")
    expect(envelope.userPrompt).toMatch(/secret/i)
  })

  it("reports an out-of-scope step without describing it", () => {
    const steps = [view(1, { captured: captured(1, { kind: "outOfScope", element: undefined }) })]
    const envelope = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(envelope.userPrompt).toMatch(/skipped/i)
  })
})

describe("redaction", () => {
  it("replaces personal information and says so", () => {
    const steps = [
      view(1, { captured: captured(1, { element: { name: "email: person@example.com" } }) }),
    ]
    const envelope = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(envelope.redacted).toBe(true)
    expect(envelope.userPrompt).not.toContain("person@example.com")
  })

  it("leaves a clean transcript untouched", () => {
    const envelope = buildGenerationEnvelope([view(1)], options(), CATEGORY_IDS)
    expect(envelope.redacted).toBe(false)
  })
})

describe("the system prompt", () => {
  it("names the locale the skill should be written in", () => {
    const envelope = buildGenerationEnvelope([view(1)], options({ locale: "zh-CN" }), CATEGORY_IDS)
    expect(envelope.systemPrompt).toContain("zh-CN")
  })

  it("constrains the model to the live tool catalog", () => {
    const envelope = buildGenerationEnvelope(
      [view(1)],
      options({ toolCatalog: ["Read", "Bash"] }),
      CATEGORY_IDS
    )
    expect(envelope.systemPrompt).toContain("Read, Bash")
    expect(envelope.systemPrompt).toMatch(/never invent tool names/i)
  })

  it("asks for an empty tool list when the catalog is empty", () => {
    // An empty catalog means "we could not enumerate", which must not read as
    // "anything goes".
    const envelope = buildGenerationEnvelope([view(1)], options({ toolCatalog: [] }), CATEGORY_IDS)
    expect(envelope.systemPrompt).toMatch(/empty allowedTools/i)
  })

  it("carries the four required sections and the category list", () => {
    const envelope = buildGenerationEnvelope([view(1)], options(), CATEGORY_IDS)
    for (const heading of ["## When to use", "## Inputs", "## Steps", "## Verify"]) {
      expect(envelope.systemPrompt).toContain(heading)
    }
    expect(envelope.systemPrompt).toContain(CATEGORY_IDS)
  })
})

describe("truncation", () => {
  it("caps the transcript and reports what was left out", () => {
    const steps = Array.from({ length: MAX_ENVELOPE_STEPS + 5 }, (_, i) => view(i + 1))
    const envelope = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(envelope.describedSteps).toBe(MAX_ENVELOPE_STEPS)
    expect(envelope.truncatedSteps).toBe(5)
    expect(envelope.userPrompt).toContain("5 further steps")
  })

  it("reports nothing truncated when everything fits", () => {
    const envelope = buildGenerationEnvelope([view(1)], options(), CATEGORY_IDS)
    expect(envelope.truncatedSteps).toBe(0)
    expect(envelope.userPrompt).not.toContain("further steps")
  })
})

describe("determinism", () => {
  /**
   * The preview renders these exact strings and `generateSkillFromEnvelope`
   * sends these exact strings. If the same input ever produced two different
   * envelopes, "preview exactly what leaves the device" would be untrue.
   */
  it("is byte-identical for identical input", () => {
    const steps = [
      view(1),
      view(2, { intent: "Open the invoice" }),
      view(3, { verify: "It saved" }),
    ]
    const first = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    const second = buildGenerationEnvelope(steps, options(), CATEGORY_IDS)
    expect(second.systemPrompt).toBe(first.systemPrompt)
    expect(second.userPrompt).toBe(first.userPrompt)
  })
})

describe("step descriptions", () => {
  it("prefers the user's intent over the recorded label", () => {
    const envelope = buildGenerationEnvelope(
      [view(1, { intent: "Open the monthly report" })],
      options(),
      CATEGORY_IDS
    )
    expect(envelope.userPrompt).toContain("Open the monthly report")
    expect(envelope.userPrompt).not.toContain("Button 1")
  })

  it("falls back to the OCR hint when accessibility gave nothing", () => {
    const steps = [
      view(1, { captured: captured(1, { element: undefined, ocrHint: "Submit order" }) }),
    ]
    expect(buildGenerationEnvelope(steps, options(), CATEGORY_IDS).userPrompt).toContain(
      "Submit order"
    )
  })

  it("describes a shortcut structurally", () => {
    const steps = [
      view(1, { captured: captured(1, { kind: "type", text: { kind: "keys", chord: "ctrl+c" } }) }),
    ]
    expect(buildGenerationEnvelope(steps, options(), CATEGORY_IDS).userPrompt).toContain("ctrl+c")
  })

  it("names the scroll direction", () => {
    const down = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { kind: "scroll", scrollDy: -120 }) })],
      options(),
      CATEGORY_IDS
    )
    expect(down.userPrompt).toMatch(/scroll down/i)
  })

  it("names a manual step as one, whether or not it has a capture", () => {
    const fromEdit = buildGenerationEnvelope(
      [view(-1, { manual: true, captured: null })],
      options(),
      CATEGORY_IDS
    )
    expect(fromEdit.userPrompt).toContain("(manual step)")
    // A view with no capture behind it reads the same way even if the manual
    // flag was lost — the model must not be told a control was clicked.
    const orphan = buildGenerationEnvelope([view(1, { captured: null })], options(), CATEGORY_IDS)
    expect(orphan.userPrompt).toContain("(manual step)")
  })

  it("falls back through automation id, control type, then an honest placeholder", () => {
    const byAutomationId = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { element: { automationId: "btnSave" } }) })],
      options(),
      CATEGORY_IDS
    )
    expect(byAutomationId.userPrompt).toContain("btnSave")

    const byControlType = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { element: { controlType: "Button" } }) })],
      options(),
      CATEGORY_IDS
    )
    expect(byControlType.userPrompt).toContain("Button")

    const nothing = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { element: undefined }) })],
      options(),
      CATEGORY_IDS
    )
    expect(nothing.userPrompt).toContain("an unlabeled control")
  })

  it("names the window a step happened in, when the capture knew one", () => {
    const envelope = buildGenerationEnvelope(
      [
        view(1, {
          captured: captured(1, { element: { name: "Export", windowTitle: "Invoices" } }),
        }),
      ],
      options(),
      CATEGORY_IDS
    )
    expect(envelope.userPrompt).toContain('in "Invoices"')
  })

  it("truncates an over-long label rather than shipping the whole thing", () => {
    const envelope = buildGenerationEnvelope(
      [view(1, { intent: "x".repeat(400) })],
      options(),
      CATEGORY_IDS
    )
    expect(envelope.userPrompt).toContain("…")
    expect(envelope.userPrompt).not.toContain("x".repeat(400))
  })

  it("describes typing with no text captured at all", () => {
    const envelope = buildGenerationEnvelope(
      [view(1, { captured: captured(1, { kind: "type" }) })],
      options(),
      CATEGORY_IDS
    )
    expect(envelope.userPrompt).toMatch(/Type into "Button 1"/)
  })

  it("scrolls up on a non-negative delta, and with no delta at all", () => {
    for (const patch of [{ scrollDy: 120 }, {}]) {
      const envelope = buildGenerationEnvelope(
        [view(1, { captured: captured(1, { kind: "scroll", ...patch }) })],
        options(),
        CATEGORY_IDS
      )
      expect(envelope.userPrompt).toMatch(/scroll up/i)
    }
  })

  it("collects verification conditions the user wrote", () => {
    const envelope = buildGenerationEnvelope(
      [view(1, { verify: "The invoice appears in the list" })],
      options(),
      CATEGORY_IDS
    )
    expect(envelope.userPrompt).toContain("The invoice appears in the list")
  })
})
