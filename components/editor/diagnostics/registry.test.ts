import { getDiagnosticsProducer } from "./registry"
import { lintJson } from "./lint-json"
import { lintBabel } from "./lint-babel"

describe("getDiagnosticsProducer", () => {
  it("returns the JSON producer for json", () => {
    expect(getDiagnosticsProducer("json")).toBe(lintJson)
  })

  it("returns the babel producer for typescript", () => {
    expect(getDiagnosticsProducer("typescript")).toBe(lintBabel)
  })

  it("returns null for languages without a parser", () => {
    expect(getDiagnosticsProducer("python")).toBeNull()
    expect(getDiagnosticsProducer("shell")).toBeNull()
    expect(getDiagnosticsProducer("markdown")).toBeNull()
    expect(getDiagnosticsProducer("plaintext")).toBeNull()
  })
})
