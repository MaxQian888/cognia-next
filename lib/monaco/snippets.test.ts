import { registerAllSnippets, registerEmmetSupport } from "./snippets"

describe("monaco snippets stubs", () => {
  it("registerAllSnippets returns an empty array", () => {
    expect(registerAllSnippets({})).toEqual([])
  })

  it("registerEmmetSupport returns an empty array", () => {
    expect(registerEmmetSupport(null)).toEqual([])
  })
})
