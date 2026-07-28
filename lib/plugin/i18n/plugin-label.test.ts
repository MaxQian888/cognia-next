import { resolveOptionalPluginLabel, resolvePluginLabel } from "./plugin-label"

const translator = Object.assign(
  (key: string) => ({ "plugin.acme.panel.title": "Localized title" })[key] ?? key,
  {
    has: (key: string) => key === "plugin.acme.panel.title",
  }
)

describe("resolvePluginLabel", () => {
  it("prefers a registered plugin translation", () => {
    expect(resolvePluginLabel(translator, "acme", "panel.title", "Fallback")).toBe(
      "Localized title"
    )
  })

  it("falls back to the literal label when the key is absent", () => {
    expect(resolvePluginLabel(translator, "acme", "missing", "Fallback")).toBe("Fallback")
  })

  it("falls back when no key was declared", () => {
    expect(resolvePluginLabel(translator, "acme", undefined, "Fallback")).toBe("Fallback")
  })
})

describe("resolveOptionalPluginLabel", () => {
  // The regression this variant exists for: a manifest that localizes its title
  // and therefore ships no literal. Guarding on the literal skipped the
  // translator entirely and the surface rendered headerless.
  it("resolves a key even when no literal label accompanies it", () => {
    expect(resolveOptionalPluginLabel(translator, "acme", "panel.title", undefined)).toBe(
      "Localized title"
    )
  })

  it("prefers the key over the literal", () => {
    expect(resolveOptionalPluginLabel(translator, "acme", "panel.title", "Literal")).toBe(
      "Localized title"
    )
  })

  it("falls back to the literal when the key is not in the bundle", () => {
    expect(resolveOptionalPluginLabel(translator, "acme", "missing", "Literal")).toBe("Literal")
  })

  it("reports undefined when neither a key nor a literal yields anything", () => {
    expect(resolveOptionalPluginLabel(translator, "acme", undefined, undefined)).toBeUndefined()
    expect(resolveOptionalPluginLabel(translator, "acme", "missing", undefined)).toBeUndefined()
  })

  // `has` is optional on the translator type — several hosts pass next-intl's
  // `t` through a cast, and a stub without it must not throw.
  it("treats a translator with no `has` as having no plugin bundle", () => {
    const bare = ((key: string) => key) as typeof translator
    expect(resolveOptionalPluginLabel(bare, "acme", "panel.title", "Literal")).toBe("Literal")
    expect(resolveOptionalPluginLabel(bare, "acme", "panel.title", undefined)).toBeUndefined()
  })
})
