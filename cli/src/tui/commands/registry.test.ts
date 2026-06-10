/**
 * @jest-environment node
 */
import { SLASH_COMMANDS } from "./registry"

describe("SLASH_COMMANDS", () => {
  it("is a non-empty catalog of unique, described commands", () => {
    expect(SLASH_COMMANDS.length).toBeGreaterThan(4)
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]+$/)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  it("includes the core commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(["model", "mode", "sessions", "clear", "help", "exit"])
    )
  })
})
