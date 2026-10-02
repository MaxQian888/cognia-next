import en from "./messages/en.json"
import zh from "./messages/zh-CN.json"
import { startupMessages } from "./messages"
import { loadRouteMessages, routeMessageScope } from "./route-messages"

function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe("routeMessageScope", () => {
  it("scopes only the public status document", () => {
    for (const pathname of ["/status", "/status/", "/status.html", "/status/index.html"]) {
      expect(routeMessageScope(pathname)).toBe("publicStatus")
    }
    for (const pathname of [null, undefined, "", "/", "/statuses", "/settings", "/pet-overlay"]) {
      expect(routeMessageScope(pathname)).toBeNull()
    }
  })
})

describe("loadRouteMessages", () => {
  it.each(["en", "zh-CN"] as const)(
    "loads %s publicStatus plus the startup namespaces, nothing else",
    async (locale) => {
      const messages = await loadRouteMessages("publicStatus", locale)
      const full = locale === "en" ? en : zh
      expect(messages.publicStatus).toEqual(full.publicStatus)
      expect(Object.keys(messages).sort()).toEqual(
        [...Object.keys(startupMessages[locale]), "publicStatus"].sort()
      )
    }
  )

  it("ships the same publicStatus keys in every locale", async () => {
    const english = await loadRouteMessages("publicStatus", "en")
    const chinese = await loadRouteMessages("publicStatus", "zh-CN")
    expect(keyPaths(chinese.publicStatus).sort()).toEqual(keyPaths(english.publicStatus).sort())
  })
})
