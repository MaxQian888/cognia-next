import { CHAT_CODE_THEME } from "./code-theme"

describe("CHAT_CODE_THEME", () => {
  it("exposes a distinct, non-empty light/dark Shiki theme pair", () => {
    expect(typeof CHAT_CODE_THEME.light).toBe("string")
    expect(typeof CHAT_CODE_THEME.dark).toBe("string")
    expect(CHAT_CODE_THEME.light.length).toBeGreaterThan(0)
    expect(CHAT_CODE_THEME.dark.length).toBeGreaterThan(0)
    expect(CHAT_CODE_THEME.light).not.toBe(CHAT_CODE_THEME.dark)
  })

  it("pins the canonical chat code theme so every surface stays in sync", () => {
    // This guards the streaming↔finalized consistency contract: if someone
    // changes one surface's theme, this fixture forces them to update the
    // shared source of truth (and thus every surface) together.
    expect(CHAT_CODE_THEME).toEqual({ light: "one-light", dark: "one-dark-pro" })
  })
})
