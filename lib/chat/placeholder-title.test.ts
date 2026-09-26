import { PLACEHOLDER_TITLES, isPlaceholderTitle, sessionDisplayTitle } from "./placeholder-title"

const labels = { untitled: "(untitled)", placeholder: "新对话" }

describe("isPlaceholderTitle", () => {
  it("treats empty and machine placeholders as unnamed", () => {
    expect(isPlaceholderTitle("")).toBe(true)
    expect(isPlaceholderTitle(null)).toBe(true)
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle("New chat")).toBe(true)
    expect(isPlaceholderTitle("新对话")).toBe(true)
  })

  it("leaves a real title alone", () => {
    expect(isPlaceholderTitle("Quarterly plan")).toBe(false)
  })

  it("covers the default createSession writes", () => {
    expect(PLACEHOLDER_TITLES.has("New chat")).toBe(true)
    expect(PLACEHOLDER_TITLES.has("New conversation")).toBe(true)
  })
})

describe("sessionDisplayTitle", () => {
  it("prints a real title as stored", () => {
    expect(sessionDisplayTitle("Quarterly plan", labels)).toBe("Quarterly plan")
  })

  it("says untitled for an empty title", () => {
    expect(sessionDisplayTitle("", labels)).toBe("(untitled)")
    expect(sessionDisplayTitle(undefined, labels)).toBe("(untitled)")
  })

  it("localizes a stored machine placeholder", () => {
    expect(sessionDisplayTitle("New chat", labels)).toBe("新对话")
    expect(sessionDisplayTitle("New conversation", labels)).toBe("新对话")
  })
})
