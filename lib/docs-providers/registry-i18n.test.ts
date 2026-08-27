/**
 * @jest-environment node
 *
 * The composer's `+` menu labels each cloud-document provider with
 * `docsProviders.name.<id>`, built from the provider id at render time. A
 * template key is invisible to `lint:i18n`, so the catalogue is pinned here
 * instead: every registered provider must have a name in BOTH locales, or the
 * menu renders its own key path at people.
 */
import en from "@/i18n/messages/en/docsProviders.json"
import zh from "@/i18n/messages/zh-CN/docsProviders.json"
import { listDocsProviders } from "./registry"
import "./index"

describe("docs provider name catalogue", () => {
  const ids = listDocsProviders().map((p) => p.id)

  it("registers at least the built-ins", () => {
    expect(ids.length).toBeGreaterThan(0)
  })

  it.each(["en", "zh-CN"])("names every registered provider in %s", (locale) => {
    const names = (locale === "en" ? en : zh).name as Record<string, string>
    for (const id of ids) {
      expect(typeof names[id]).toBe("string")
      expect(names[id]).not.toBe("")
    }
  })
})
