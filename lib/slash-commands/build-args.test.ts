import { buildArgs, firstMissingRequired } from "./build-args"
import type { SlashParamSpec } from "./builtin"

const spec = (p: Partial<SlashParamSpec> & { name: string }): SlashParamSpec => ({
  label: p.name,
  type: "string",
  ...p,
})

describe("buildArgs", () => {
  it("emits flag pairs by default", () => {
    const specs = [spec({ name: "provider" }), spec({ name: "lang" })]
    expect(buildArgs(specs, { provider: "auto", lang: "en" })).toBe("--provider auto --lang en")
  })

  it("emits positional values in spec order", () => {
    const specs = [
      spec({ name: "interval", style: "positional" }),
      spec({ name: "prompt", style: "positional" }),
    ]
    expect(buildArgs(specs, { interval: "5m", prompt: "check deploy" })).toBe("5m check deploy")
  })

  it("emits multi-word values raw (downstream parsers consume them verbatim)", () => {
    const specs = [spec({ name: "focus", style: "positional" })]
    expect(buildArgs(specs, { focus: "auth flow handling" })).toBe("auth flow handling")
  })

  it("skips empty optional values", () => {
    const specs = [spec({ name: "a" }), spec({ name: "b" })]
    expect(buildArgs(specs, { a: "x", b: "" })).toBe("--a x")
  })

  it("falls back to defaults when a value is absent", () => {
    const specs = [spec({ name: "provider", default: "auto" })]
    expect(buildArgs(specs, {})).toBe("--provider auto")
  })

  it("emits a bare flag for a truthy boolean and nothing for falsy", () => {
    const specs = [spec({ name: "force", type: "boolean" })]
    expect(buildArgs(specs, { force: "true" })).toBe("--force")
    expect(buildArgs(specs, { force: "" })).toBe("")
    expect(buildArgs(specs, { force: "false" })).toBe("")
  })
})

describe("firstMissingRequired", () => {
  it("returns the first unfilled required field", () => {
    const specs = [spec({ name: "a", required: true }), spec({ name: "b", required: true })]
    expect(firstMissingRequired(specs, { a: "x" })?.name).toBe("b")
  })

  it("returns null when all required fields are filled", () => {
    const specs = [spec({ name: "a", required: true, default: "d" })]
    expect(firstMissingRequired(specs, {})).toBeNull()
  })

  it("ignores booleans and optionals", () => {
    const specs = [spec({ name: "flag", type: "boolean", required: true }), spec({ name: "opt" })]
    expect(firstMissingRequired(specs, {})).toBeNull()
  })
})
