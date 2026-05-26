import { resolveWelcomeMessage } from "./welcome"

describe("resolveWelcomeMessage", () => {
  it("returns the trimmed configured welcome", () => {
    expect(resolveWelcomeMessage({ welcomeMessage: "  Hi there  " })).toBe("Hi there")
  })

  it("returns null when unset, empty, or non-string", () => {
    expect(resolveWelcomeMessage(undefined)).toBeNull()
    expect(resolveWelcomeMessage({})).toBeNull()
    expect(resolveWelcomeMessage({ welcomeMessage: "   " })).toBeNull()
    expect(resolveWelcomeMessage({ welcomeMessage: 42 as unknown as string })).toBeNull()
  })
})
