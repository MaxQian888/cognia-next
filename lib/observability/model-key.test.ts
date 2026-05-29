import { UNKNOWN_MODEL, modelKeyOf } from "./model-key"
import { makeSpan } from "./fixtures"

describe("modelKeyOf", () => {
  it("prefers responseModel", () => {
    expect(modelKeyOf(makeSpan({ responseModel: "r", requestModel: "q" }))).toBe("r")
  })

  it("falls back to requestModel", () => {
    expect(modelKeyOf(makeSpan({ requestModel: "q" }))).toBe("q")
  })

  it("uses the unknown sentinel when neither is present", () => {
    expect(modelKeyOf(makeSpan({}))).toBe(UNKNOWN_MODEL)
  })
})
