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
import { DOCS_PROVIDER_BLOCKS } from "./reach"
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

/**
 * `DocsProviderNotice` builds `docsProviders.reach.<group>.<block>` from the
 * resolver's output, and the mobile composer builds `reach.short.<block>`.
 * Both are template keys, so `lint:i18n` cannot see them. Pin the catalogue
 * here or a blocked phone renders a key path where the explanation should be.
 */
describe("docs provider reach catalogue", () => {
  it.each(["en", "zh-CN"])("explains every block in %s", (locale) => {
    const reach = (locale === "en" ? en : zh).reach as Record<string, Record<string, string>>
    for (const group of ["block", "nextStep", "short"]) {
      expect(reach[group]).toBeDefined()
      for (const block of DOCS_PROVIDER_BLOCKS) {
        expect(typeof reach[group][block]).toBe("string")
        expect(reach[group][block]).not.toBe("")
      }
    }
  })

  it("carries no copy for a block the resolver cannot emit", () => {
    // A stale key outlives the reason it explained and quietly rots. The
    // resolver's union is the source of truth.
    for (const messages of [en, zh]) {
      const reach = messages.reach as Record<string, Record<string, string>>
      for (const group of ["block", "nextStep", "short"]) {
        expect(Object.keys(reach[group]).sort()).toEqual([...DOCS_PROVIDER_BLOCKS].sort())
      }
    }
  })
})
