import { interpolateTemplatePayload, resolveTemplateInputs } from "./interpolate"
import type { TemplateInputSpec } from "./contracts"

const inputs: TemplateInputSpec[] = [
  { id: "teamName", label: "Team", kind: "string", required: true },
  { id: "depth", label: "Depth", kind: "string", required: false, defaultValue: "quick" },
  { id: "note", label: "Note", kind: "string", required: false },
]

describe("resolveTemplateInputs", () => {
  it("prefers a binding over the declared default", () => {
    expect(resolveTemplateInputs(inputs, { teamName: "Platform", depth: "thorough" })).toEqual({
      teamName: "Platform",
      depth: "thorough",
    })
  })

  it("falls back to the default for an unbound optional input", () => {
    expect(resolveTemplateInputs(inputs, { teamName: "Platform" })).toEqual({
      teamName: "Platform",
      depth: "quick",
    })
  })

  it("leaves an input with neither a binding nor a default absent", () => {
    expect(resolveTemplateInputs(inputs, {})).not.toHaveProperty("note")
  })

  it("treats an empty binding as unbound", () => {
    expect(resolveTemplateInputs(inputs, { depth: "" }).depth).toBe("quick")
  })
})

describe("interpolateTemplatePayload", () => {
  it("substitutes a declared input wherever it appears", () => {
    expect(
      interpolateTemplatePayload(
        {
          team: { name: "{{teamName}}", task: "Review at {{depth}} depth" },
          tags: ["{{teamName}}", "static"],
        },
        { teamName: "Platform", depth: "thorough" }
      )
    ).toEqual({
      team: { name: "Platform", task: "Review at thorough depth" },
      tags: ["Platform", "static"],
    })
  })

  it("tolerates padding inside the braces, as the validator does", () => {
    expect(interpolateTemplatePayload("{{ teamName }}", { teamName: "Platform" })).toBe("Platform")
  })

  // A workflow expression is evaluated when the workflow RUNS. Rewriting one
  // here turns a live expression into a dead string.
  it("leaves a token that is not a declared input exactly as written", () => {
    const payload = { expr: "{{ steps.a.output }}", unknown: "{{nope}}" }
    expect(interpolateTemplatePayload(payload, { teamName: "Platform" })).toEqual(payload)
  })

  it("leaves an unsupplied optional input's token visible rather than blanking it", () => {
    expect(interpolateTemplatePayload("Note: {{note}}", { teamName: "x" })).toBe("Note: {{note}}")
  })

  it("returns the same object when nothing matched, so callers can skip work", () => {
    const payload = { a: "plain", b: ["also plain"] }
    expect(interpolateTemplatePayload(payload, { teamName: "Platform" })).toBe(payload)
    expect(interpolateTemplatePayload(payload, {})).toBe(payload)
  })

  it("leaves non-string leaves alone", () => {
    const payload = { n: 3, b: true, nil: null, list: [1, "{{teamName}}"] }
    expect(interpolateTemplatePayload(payload, { teamName: "P" })).toEqual({
      n: 3,
      b: true,
      nil: null,
      list: [1, "P"],
    })
  })

  it("substitutes several tokens in one string", () => {
    expect(interpolateTemplatePayload("{{a}} and {{b}} and {{a}}", { a: "one", b: "two" })).toBe(
      "one and two and one"
    )
  })

  // A value that itself looks like a token must not be re-scanned.
  it("does not interpolate the substituted value", () => {
    expect(interpolateTemplatePayload("{{a}}", { a: "{{b}}", b: "deep" })).toBe("{{b}}")
  })
})
