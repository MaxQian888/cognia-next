import { surfaceLabelKey } from "./usage-surface-labels"
import { USAGE_SURFACES } from "@/lib/db/session-usage"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

type Catalogue = Record<string, unknown>

function surfaceCatalogue(messages: Catalogue): Record<string, string> {
  const subscription = messages.subscription as Catalogue
  const usage = subscription.usage as Catalogue
  return usage.surface as Record<string, string>
}

describe("surfaceLabelKey", () => {
  it("maps kebab-case surface ids onto camelCase catalogue leaves", () => {
    expect(surfaceLabelKey("agent-team")).toBe("agentTeam")
    expect(surfaceLabelKey("web-search")).toBe("webSearch")
    expect(surfaceLabelKey("chat")).toBe("chat")
  })

  it("falls back to the raw id for a surface it does not know", () => {
    expect(surfaceLabelKey("surface-from-the-future")).toBe("surface-from-the-future")
  })

  // The Usage tab and the /usage card both build `surface.<leaf>` keys at
  // runtime, so `lint:i18n` cannot see them. This is the guard that a new
  // surface never renders as a raw key path.
  it.each(["en", "zh-CN"])("has a %s label for every declared surface", (locale) => {
    const catalogue = surfaceCatalogue(
      (locale === "en" ? enMessages : zhMessages) as unknown as Catalogue
    )
    expect(USAGE_SURFACES.length).toBeGreaterThan(0)
    for (const surface of USAGE_SURFACES) {
      expect(catalogue[surfaceLabelKey(surface)]).toBeTruthy()
    }
  })
})
