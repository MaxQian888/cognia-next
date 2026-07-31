import { interpolate, CANNED_VARIABLES } from "./canned-interpolate"

describe("interpolate", () => {
  it("substitutes known tokens", () => {
    expect(interpolate("Hi {{contact.name}}", { contact: { name: "Ada" } })).toBe("Hi Ada")
  })

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("Hi {{  contact.name  }}", { contact: { name: "Ada" } })).toBe("Hi Ada")
  })

  it("resolves unknown tokens to an empty string (never leaks the placeholder)", () => {
    expect(interpolate("Hi {{contact.name}}!", {})).toBe("Hi !")
    expect(interpolate("{{nope.missing}}", { contact: { name: "Ada" } })).toBe("")
  })

  it("handles multiple tokens and leaves plain text untouched", () => {
    const out = interpolate("{{operator.name}} → {{contact.handle}} on {{contact.platform}}", {
      operator: { name: "Me" },
      contact: { handle: "@bob", platform: "slack" },
    })
    expect(out).toBe("Me → @bob on slack")
  })

  it("stringifies non-string leaf values", () => {
    // @ts-expect-error — exercising a non-string leaf at runtime
    expect(interpolate("{{contact.name}}", { contact: { name: 42 } })).toBe("42")
  })

  it("exposes the advertised variable list", () => {
    expect(CANNED_VARIABLES).toContain("contact.name")
    expect(CANNED_VARIABLES.length).toBeGreaterThan(0)
  })
})
