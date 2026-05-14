import { tNode } from "./node-translate"

describe("tNode", () => {
  it("returns the translation when the key resolves", () => {
    const t = Object.assign((key: string) => `translated:${key}`, { has: (_k: string) => true })
    expect(tNode(t, "trigger.cron.label", "On schedule")).toBe("translated:trigger.cron.label")
  })

  it("returns the fallback when t.has reports the key is missing", () => {
    const t = Object.assign(
      (key: string) => {
        throw new Error(`should not be called for missing key: ${key}`)
      },
      { has: (_k: string) => false }
    )
    expect(tNode(t, "plugin.example.label", "My Plugin Node")).toBe("My Plugin Node")
  })

  it("falls back when t throws and has() is unavailable", () => {
    const t = (_key: string): string => {
      throw new Error("MISSING_MESSAGE")
    }
    expect(tNode(t as never, "trigger.cron.label", "On schedule")).toBe("On schedule")
  })

  it("returns the value when has() is unavailable and t() succeeds", () => {
    const t = (key: string) => `ok:${key}`
    expect(tNode(t as never, "trigger.cron.label", "On schedule")).toBe("ok:trigger.cron.label")
  })
})
