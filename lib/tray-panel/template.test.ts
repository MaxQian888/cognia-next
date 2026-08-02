import {
  defaultValuesFor,
  extractPlaceholders,
  formatFieldValue,
  interpolate,
  isFieldEmpty,
} from "./template"
import type { TrayPanelField } from "./types"

const known = (...ids: string[]) => new Set(ids)

describe("formatFieldValue", () => {
  it("renders each value kind the way a prompt should read it", () => {
    expect(formatFieldValue("hi")).toBe("hi")
    expect(formatFieldValue(true)).toBe("true")
    expect(formatFieldValue(false)).toBe("false")
    expect(formatFieldValue(42)).toBe("42")
  })

  it("renders absent and non-finite values as empty", () => {
    expect(formatFieldValue(undefined)).toBe("")
    expect(formatFieldValue(Number.NaN)).toBe("")
    expect(formatFieldValue(Number.POSITIVE_INFINITY)).toBe("")
  })
})

describe("interpolate", () => {
  it("substitutes declared placeholders", () => {
    const result = interpolate(
      "Review {{path}} for {{goal}}",
      { path: "app.ts", goal: "bugs" },
      known("path", "goal")
    )
    expect(result.text).toBe("Review app.ts for bugs")
    expect(result.missing).toEqual([])
  })

  it("tolerates whitespace inside the braces", () => {
    const result = interpolate("{{ path }}", { path: "x" }, known("path"))
    expect(result.text).toBe("x")
  })

  it("substitutes an empty string for a declared but unset field", () => {
    const result = interpolate("a{{gap}}b", {}, known("gap"))
    expect(result.text).toBe("ab")
    expect(result.missing).toEqual([])
  })

  it("reports undeclared placeholders instead of blanking them", () => {
    // A typo must be visible: silently substituting "" would ship a subtly
    // wrong instruction to the model with no sign anything went wrong.
    const result = interpolate("Do {{tpyo}} now", { typo: "x" }, known("typo"))
    expect(result.text).toBe("Do {{tpyo}} now")
    expect(result.missing).toEqual(["tpyo"])
  })

  it("de-duplicates a repeated undeclared placeholder", () => {
    const result = interpolate("{{a}} {{a}}", {}, known())
    expect(result.missing).toEqual(["a"])
  })

  it("substitutes every occurrence of the same placeholder", () => {
    const result = interpolate("{{x}}-{{x}}", { x: "9" }, known("x"))
    expect(result.text).toBe("9-9")
  })

  it("leaves text without placeholders untouched", () => {
    const result = interpolate("plain { not } a placeholder", {}, known())
    expect(result.text).toBe("plain { not } a placeholder")
    expect(result.missing).toEqual([])
  })
})

describe("extractPlaceholders", () => {
  it("returns ids in first-seen order without duplicates", () => {
    expect(extractPlaceholders("{{b}} {{a}} {{b}}")).toEqual(["b", "a"])
  })

  it("returns an empty list for a plain string", () => {
    expect(extractPlaceholders("nothing here")).toEqual([])
  })
})

describe("defaultValuesFor", () => {
  it("seeds each field kind from its declared default", () => {
    const fields: TrayPanelField[] = [
      { kind: "text", id: "t", label: "T", defaultValue: "seed" },
      { kind: "textarea", id: "ta", label: "TA" },
      {
        kind: "select",
        id: "s",
        label: "S",
        options: [{ value: "a", label: "A" }],
        defaultValue: "a",
      },
      { kind: "switch", id: "sw", label: "SW", defaultValue: true },
      { kind: "number", id: "n", label: "N", defaultValue: 7 },
    ]
    expect(defaultValuesFor(fields)).toEqual({ t: "seed", ta: "", s: "a", sw: true, n: 7 })
  })

  it("falls back to a number field's min so it never opens already-invalid", () => {
    const fields: TrayPanelField[] = [{ kind: "number", id: "n", label: "N", min: 3 }]
    expect(defaultValuesFor(fields)).toEqual({ n: 3 })
  })

  it("falls back to 0 for a number field with neither default nor min", () => {
    expect(defaultValuesFor([{ kind: "number", id: "n", label: "N" }])).toEqual({ n: 0 })
  })

  it("defaults a switch to off", () => {
    expect(defaultValuesFor([{ kind: "switch", id: "sw", label: "SW" }])).toEqual({ sw: false })
  })
})

describe("isFieldEmpty", () => {
  const text: TrayPanelField = { kind: "text", id: "t", label: "T" }
  const sw: TrayPanelField = { kind: "switch", id: "sw", label: "SW" }
  const num: TrayPanelField = { kind: "number", id: "n", label: "N" }

  it("treats whitespace-only text as empty", () => {
    expect(isFieldEmpty(text, "   ")).toBe(true)
    expect(isFieldEmpty(text, "x")).toBe(false)
  })

  it("never treats a switch as empty", () => {
    expect(isFieldEmpty(sw, false)).toBe(false)
    expect(isFieldEmpty(sw, true)).toBe(false)
  })

  it("treats a non-finite or non-numeric number as empty", () => {
    expect(isFieldEmpty(num, Number.NaN)).toBe(true)
    expect(isFieldEmpty(num, "")).toBe(true)
    expect(isFieldEmpty(num, 0)).toBe(false)
  })

  it("treats an absent value as empty", () => {
    expect(isFieldEmpty(text, undefined)).toBe(true)
    expect(isFieldEmpty(sw, undefined)).toBe(true)
  })
})
