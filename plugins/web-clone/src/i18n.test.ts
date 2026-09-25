import manifestJson from "../plugin.json"
import { englishWebCloneT, interpolateWebCloneMessage } from "./i18n"

describe("web-clone i18n helpers", () => {
  it("interpolates known params and leaves unknown ones literal", () => {
    expect(interpolateWebCloneMessage("x {a} {b}", { a: 1 })).toBe("x 1 {b}")
    expect(interpolateWebCloneMessage("x {a}", undefined)).toBe("x {a}")
    expect(interpolateWebCloneMessage("{flag}!", { flag: false })).toBe("false!")
  })

  it("translates from plugin.json's English bundle and falls back to the key", () => {
    expect(englishWebCloneT("failed", { error: "boom" })).toBe("web-clone failed: boom")
    expect(englishWebCloneT("no.such.key")).toBe("no.such.key")
  })

  it("keeps the two locales in step, with unprefixed keys and every placeholder carried over", () => {
    const en = manifestJson.i18n.locales.en as Record<string, string>
    const zh = manifestJson.i18n.locales["zh-CN"] as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(key.startsWith("plugin.")).toBe(false)
      const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
      expect(placeholders(zh[key])).toEqual(placeholders(en[key]))
    }
  })
})
