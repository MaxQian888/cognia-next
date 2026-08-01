import { buildManualSkillDraft, type ManualTemplateStrings } from "./manual-template"
import type { InputVariable } from "./input-variables"
import type { RecordedStepView } from "./step-model"

const STRINGS: ManualTemplateStrings = {
  whenToUseHeading: "When to use",
  inputsHeading: "Inputs",
  stepsHeading: "Steps",
  verifyHeading: "Verify",
  whenToUseBody: "Use this in Safari.",
  noInputs: "No inputs.",
  noVerify: "No checks recorded.",
  secretSuffix: "secret",
  defaultName: "Recorded skill",
  defaultDescription: "Captured from a recording.",
  unnamedStep: "Unnamed step",
  clickStep: (target) => `Click ${target}`,
  typeStep: (target, value) => `Type ${value} into ${target}`,
  secretStep: (target) => `Enter the secret into ${target}`,
  keysStep: (chord) => `Press ${chord}`,
  scrollStep: (direction) => `Scroll ${direction}`,
}

function view(patch: Partial<RecordedStepView> = {}): RecordedStepView {
  return {
    seq: 1,
    captured: { seq: 1, tsMs: 0, kind: "click" },
    manual: false,
    excluded: false,
    intent: null,
    verify: null,
    screenshotSelected: false,
    needsIntent: false,
    ...patch,
  }
}

function build(views: RecordedStepView[], variables: InputVariable[] = []) {
  return buildManualSkillDraft({
    views,
    variables,
    strings: STRINGS,
    category: "custom",
    tags: ["recorded"],
  })
}

describe("buildManualSkillDraft", () => {
  it("emits all four sections in order", () => {
    const { content } = build([view()])
    expect(content.match(/^## .+$/gm)).toEqual([
      "## When to use",
      "## Inputs",
      "## Steps",
      "## Verify",
    ])
  })

  it("describes each step kind from the capture", () => {
    const { content } = build([
      view({ seq: 1, captured: { seq: 1, tsMs: 0, kind: "click", element: { name: "Export" } } }),
      view({
        seq: 2,
        captured: {
          seq: 2,
          tsMs: 1,
          kind: "type",
          element: { name: "Search" },
          text: { kind: "text", value: "invoices" },
        },
      }),
      view({ seq: 3, captured: { seq: 3, tsMs: 2, kind: "scroll", scrollDy: -120 } }),
    ])
    expect(content).toContain("1. Click Export")
    expect(content).toContain("2. Type invoices into Search")
    expect(content).toContain("3. Scroll down")
  })

  it("scrolls up on a positive delta", () => {
    expect(
      build([view({ captured: { seq: 1, tsMs: 0, kind: "scroll", scrollDy: 120 } })]).content
    ).toContain("Scroll up")
  })

  it("names a secret entry without ever reconstructing it", () => {
    const { content } = build([
      view({
        captured: {
          seq: 1,
          tsMs: 0,
          kind: "type",
          element: { name: "Password" },
          text: { kind: "sensitive" },
        },
      }),
    ])
    expect(content).toContain("Enter the secret into Password")
    expect(content).not.toContain("Type ")
  })

  it("renders a key chord structurally", () => {
    const { content } = build([
      view({ captured: { seq: 1, tsMs: 0, kind: "type", text: { kind: "keys", chord: "cmd+c" } } }),
    ])
    expect(content).toContain("Press cmd+c")
  })

  it("prefers the user's intent over anything derived", () => {
    const { content } = build([
      view({
        intent: "Open the monthly export",
        captured: { seq: 1, tsMs: 0, kind: "click", element: { name: "X" } },
      }),
    ])
    expect(content).toContain("1. Open the monthly export")
    expect(content).not.toContain("Click X")
  })

  it("falls back for a step nothing could describe", () => {
    expect(build([view({ captured: { seq: 1, tsMs: 0, kind: "click" } })]).content).toContain(
      "1. Unnamed step"
    )
    expect(build([view({ manual: true, captured: null })]).content).toContain("1. Unnamed step")
    expect(build([view({ captured: { seq: 1, tsMs: 0, kind: "outOfScope" } })]).content).toContain(
      "1. Unnamed step"
    )
  })

  it("uses the automation id, then the OCR hint, as the target", () => {
    expect(
      build([
        view({
          captured: { seq: 1, tsMs: 0, kind: "click", element: { automationId: "btnSave" } },
        }),
      ]).content
    ).toContain("Click btnSave")
    expect(
      build([view({ captured: { seq: 1, tsMs: 0, kind: "click", ocrHint: "Submit" } })]).content
    ).toContain("Click Submit")
  })

  it("numbers only the included steps, consecutively", () => {
    const { content } = build([
      view({ seq: 1, excluded: true, intent: "dropped" }),
      view({ seq: 2, intent: "kept a" }),
      view({ seq: 3, intent: "kept b" }),
    ])
    expect(content).toContain("1. kept a")
    expect(content).toContain("2. kept b")
    expect(content).not.toContain("dropped")
  })

  it("lists confirmed variables as placeholders and marks the secret one", () => {
    const { content } = build(
      [view()],
      [
        { name: "invoiceMonth", kind: "variable", seq: 1, sample: "March", confirmed: true },
        { name: "apiToken", kind: "sensitive", seq: 2, confirmed: true },
      ]
    )
    expect(content).toContain("- `{{invoiceMonth}}`")
    expect(content).toContain("- `{{apiToken}}` — secret")
    // The recorded sample is local-only and must not travel into the artifact.
    expect(content).not.toContain("March")
  })

  it("omits unconfirmed and literal variables", () => {
    const { content } = build(
      [view()],
      [
        { name: "unconfirmed", kind: "variable", seq: 1, confirmed: false },
        { name: "literalOne", kind: "literal", seq: 2, confirmed: true },
      ]
    )
    expect(content).toContain("No inputs.")
    expect(content).not.toContain("unconfirmed")
    expect(content).not.toContain("literalOne")
  })

  it("lists the verification notes the user wrote", () => {
    const { content } = build([
      view({ seq: 1, verify: "The file downloads." }),
      view({ seq: 2, verify: null }),
    ])
    expect(content).toContain("- The file downloads.")
  })

  it("says so when there is nothing to verify", () => {
    expect(build([view()]).content).toContain("No checks recorded.")
  })

  it("skips a verification note on an excluded step", () => {
    const { content } = build([view({ excluded: true, verify: "gone" })])
    expect(content).toContain("No checks recorded.")
  })

  it("never claims a tool — a manual template has no basis for one", () => {
    expect(build([view()]).allowedTools).toEqual([])
  })

  it("carries the caller's metadata through", () => {
    const draft = build([view()])
    expect(draft).toMatchObject({
      name: "Recorded skill",
      description: "Captured from a recording.",
      category: "custom",
      tags: ["recorded"],
    })
  })
})
