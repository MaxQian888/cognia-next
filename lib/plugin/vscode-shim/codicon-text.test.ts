import { parseCodiconText, stripCodicons } from "./codicon-text"

describe("codicon text", () => {
  it("splits icons, spinning icons and text", () => {
    expect(parseCodiconText("$(sync~spin) Indexing $(check)")).toEqual([
      { icon: "sync", spin: true },
      { text: " Indexing " },
      { icon: "check", spin: false },
    ])
  })

  it("keeps an escaped icon as text", () => {
    expect(parseCodiconText("cost: $$(x) and $(Bell)")).toEqual([
      { text: "cost: $(x) and " },
      { icon: "bell", spin: false },
    ])
  })

  it("strips icons for accessible names", () => {
    expect(stripCodicons("$(error) 3  $(warning) 1")).toBe("3 1")
    expect(stripCodicons("plain")).toBe("plain")
  })
})
