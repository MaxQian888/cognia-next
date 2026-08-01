import {
  applyVariableMapping,
  confirmVariable,
  deriveInputVariables,
  inputsForSkillBody,
  mergeInputVariables,
  slugifyVariableName,
  type InputVariable,
} from "./input-variables"
import { applyStepEdits } from "./step-model"
import type { RecordedStep, TextCapture } from "./types"

function typed(seq: number, text: TextCapture, label = `Field ${seq}`): RecordedStep {
  return { seq, tsMs: seq, kind: "type", element: { name: label }, text }
}

function views(steps: RecordedStep[]) {
  return applyStepEdits(steps)
}

describe("slugifyVariableName", () => {
  it("turns a label into a placeholder name", () => {
    expect(slugifyVariableName("Search term", 0)).toBe("search_term")
    expect(slugifyVariableName("  Invoice #  ", 0)).toBe("invoice")
  })

  it("falls back to a positional name when nothing survives", () => {
    expect(slugifyVariableName("!!!", 2)).toBe("input_3")
    expect(slugifyVariableName("", 0)).toBe("input_1")
  })
})

describe("deriveInputVariables", () => {
  it("names the input after the field, not after what was typed", () => {
    // The label is stable across runs; the value is exactly what varies.
    const derived = deriveInputVariables(
      views([typed(1, { kind: "text", value: "March invoices" }, "Search")])
    )
    expect(derived).toHaveLength(1)
    expect(derived[0].name).toBe("search")
    expect(derived[0].sample).toBe("March invoices")
  })

  it("starts every suggestion unconfirmed", () => {
    const derived = deriveInputVariables(views([typed(1, { kind: "text", value: "x" })]))
    expect(derived[0].confirmed).toBe(false)
  })

  it("marks a secret run sensitive and carries no sample", () => {
    const derived = deriveInputVariables(views([typed(1, { kind: "sensitive" })]))
    expect(derived[0].kind).toBe("sensitive")
    expect(derived[0].sample).toBeUndefined()
  })

  it("ignores a shortcut — a chord is not an input", () => {
    expect(deriveInputVariables(views([typed(1, { kind: "keys", chord: "ctrl+c" })]))).toEqual([])
  })

  it("disambiguates two fields with the same label", () => {
    const derived = deriveInputVariables(
      views([
        typed(1, { kind: "text", value: "a" }, "Date"),
        typed(2, { kind: "text", value: "b" }, "Date"),
      ])
    )
    expect(derived.map((v) => v.name)).toEqual(["date", "date_2"])
  })

  it("skips excluded steps", () => {
    const list = views([typed(1, { kind: "text", value: "a" })])
    list[0].excluded = true
    expect(deriveInputVariables(list)).toEqual([])
  })

  it("truncates a very long sample", () => {
    const derived = deriveInputVariables(
      views([typed(1, { kind: "text", value: "x".repeat(500) })])
    )
    expect(derived[0].sample!.length).toBeLessThanOrEqual(120)
  })
})

describe("mergeInputVariables", () => {
  it("keeps a confirmation through a re-derivation", () => {
    // Editing one step re-derives everything; un-answering questions the user
    // already answered would make the review pass feel adversarial.
    const existing: InputVariable[] = [
      { name: "my_name", kind: "literal", seq: 1, sample: "old", confirmed: true },
    ]
    const derived = deriveInputVariables(views([typed(1, { kind: "text", value: "new" })]))
    const merged = mergeInputVariables(derived, existing)
    expect(merged[0].confirmed).toBe(true)
    expect(merged[0].name).toBe("my_name")
    expect(merged[0].kind).toBe("literal")
    // The sample follows the fresh capture.
    expect(merged[0].sample).toBe("new")
  })

  it("keeps a sensitive variable sample-free after a merge", () => {
    const existing: InputVariable[] = [
      { name: "password", kind: "sensitive", seq: 1, confirmed: true },
    ]
    const derived = deriveInputVariables(views([typed(1, { kind: "text", value: "leaked" })]))
    expect(mergeInputVariables(derived, existing)[0].sample).toBeUndefined()
  })

  it("passes a brand-new suggestion straight through", () => {
    const derived = deriveInputVariables(views([typed(1, { kind: "text", value: "x" })]))
    expect(mergeInputVariables(derived, [])[0].confirmed).toBe(false)
  })
})

describe("confirmVariable", () => {
  const base: InputVariable[] = [
    { name: "term", kind: "variable", seq: 1, sample: "hunter2", confirmed: false },
  ]

  it("confirms and can rename in one step", () => {
    const [variable] = confirmVariable(base, 1, { name: "query" })
    expect(variable.confirmed).toBe(true)
    expect(variable.name).toBe("query")
  })

  it("drops the sample when switching to secret", () => {
    // The point of "secret" is that the value must not exist here at all.
    const [variable] = confirmVariable(base, 1, { kind: "sensitive" })
    expect(variable.sample).toBeUndefined()
  })

  it("leaves other variables alone", () => {
    const two = [...base, { name: "other", kind: "variable" as const, seq: 2, confirmed: false }]
    expect(confirmVariable(two, 1, {})[1].confirmed).toBe(false)
  })
})

describe("applyVariableMapping", () => {
  it("replaces the recorded value with the placeholder", () => {
    const variables: InputVariable[] = [
      { name: "term", kind: "variable", seq: 1, sample: "March", confirmed: true },
    ]
    expect(applyVariableMapping("March invoices", variables, 1)).toBe("{{term}} invoices")
  })

  it("substitutes wholesale when the sample is not present verbatim", () => {
    const variables: InputVariable[] = [
      { name: "term", kind: "variable", seq: 1, sample: "March", confirmed: true },
    ]
    expect(applyVariableMapping("something else", variables, 1)).toBe("{{term}}")
  })

  it("leaves a literal untouched", () => {
    const variables: InputVariable[] = [
      { name: "menu", kind: "literal", seq: 1, sample: "File", confirmed: true },
    ]
    expect(applyVariableMapping("File", variables, 1)).toBe("File")
  })

  it("emits only a placeholder for a secret", () => {
    const variables: InputVariable[] = [
      { name: "password", kind: "sensitive", seq: 1, confirmed: true },
    ]
    expect(applyVariableMapping("anything", variables, 1)).toBe("{{password}}")
  })

  it("ignores an unconfirmed variable", () => {
    const variables: InputVariable[] = [
      { name: "term", kind: "variable", seq: 1, sample: "March", confirmed: false },
    ]
    expect(applyVariableMapping("March", variables, 1)).toBe("March")
  })
})

describe("inputsForSkillBody", () => {
  it("lists variables and secrets, never literals, and never a sample", () => {
    const variables: InputVariable[] = [
      { name: "term", kind: "variable", seq: 1, sample: "March", confirmed: true },
      { name: "menu", kind: "literal", seq: 2, sample: "File", confirmed: true },
      { name: "password", kind: "sensitive", seq: 3, confirmed: true },
      { name: "pending", kind: "variable", seq: 4, confirmed: false },
    ]
    expect(inputsForSkillBody(variables)).toEqual([
      { name: "term", sensitive: false },
      { name: "password", sensitive: true },
    ])
  })
})
