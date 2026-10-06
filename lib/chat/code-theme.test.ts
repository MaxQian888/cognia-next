import { existsSync } from "node:fs"
import path from "node:path"
import { CHAT_CODE_THEME_IDS } from "@/types/appearance"
import { CHAT_CODE_THEME, CHAT_CODE_THEMES, resolveChatCodeTheme } from "./code-theme"

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

describe("CHAT_CODE_THEMES", () => {
  it("has a pair for every selectable id and nothing else", () => {
    expect(Object.keys(CHAT_CODE_THEMES).sort()).toEqual([...CHAT_CODE_THEME_IDS].sort())
  })

  it("names only Shiki bundled themes, with distinct light and dark halves", () => {
    // `shiki` is mapped to a stub under Jest, so read the theme files the real
    // package ships: a typo'd name would otherwise only fail in the browser.
    const shikiDir = path.dirname(require.resolve("shiki/package.json"))
    const themesDir = path.join(shikiDir, "..", "@shikijs", "themes", "dist")
    for (const pair of Object.values(CHAT_CODE_THEMES)) {
      expect(existsSync(path.join(themesDir, `${pair.light}.mjs`))).toBe(true)
      expect(existsSync(path.join(themesDir, `${pair.dark}.mjs`))).toBe(true)
      expect(pair.light).not.toBe(pair.dark)
    }
  })

  it("keeps the historical pair as the default", () => {
    expect(CHAT_CODE_THEMES.one).toBe(CHAT_CODE_THEME)
    expect(resolveChatCodeTheme(undefined)).toBe(CHAT_CODE_THEME)
    expect(resolveChatCodeTheme("bogus" as never)).toBe(CHAT_CODE_THEME)
    expect(resolveChatCodeTheme("github")).toEqual({
      light: "github-light-default",
      dark: "github-dark-default",
    })
  })
})
