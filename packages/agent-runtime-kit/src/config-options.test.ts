import type { AcpConfigOption } from "@cognia/agent-contracts/external-agent"
import { findModelConfigOption, flattenValues } from "./config-options"

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "a",
  options: [
    { value: "a", name: "A" },
    { group: "more", name: "More", options: [{ value: "b", name: "B" }] },
  ],
} as AcpConfigOption

describe("findModelConfigOption", () => {
  it("finds the model select", () => {
    expect(findModelConfigOption([modelOption])).toBe(modelOption)
    expect(findModelConfigOption(undefined)).toBeUndefined()
  })

  it("ignores a boolean that happens to be categorised model", () => {
    const boolish = { ...modelOption, type: "boolean", currentValue: true } as AcpConfigOption
    expect(findModelConfigOption([boolish])).toBeUndefined()
  })
})

describe("flattenValues", () => {
  it("flattens grouped and plain values in order", () => {
    const select = findModelConfigOption([modelOption])!
    expect(flattenValues(select.options).map((value) => value.value)).toEqual(["a", "b"])
  })
})
