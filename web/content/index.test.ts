import { LOCALES } from "@web/lib/locale"
import { format, getCopy } from "./index"

describe("getCopy", () => {
  it("returns a bundle for every supported locale", () => {
    for (const locale of LOCALES) {
      expect(getCopy(locale).nav.brand).toBe("Cognia")
    }
  })

  it("gives each locale its own bundle", () => {
    expect(getCopy("en").home.hero.title).not.toBe(getCopy("zh").home.hero.title)
  })
})

/**
 * The interface makes en/zh parity a compile-time property, so these tests
 * cover the parts a type cannot: that ordered, keyed collections line up
 * one-for-one, since components index into them by position and by key.
 */
describe("locale parity beyond the type system", () => {
  const [a, b] = [getCopy("en"), getCopy("zh")]

  it("keeps the signature task's six steps aligned by key and order", () => {
    expect(b.home.signature.steps.map((s) => s.key)).toEqual(
      a.home.signature.steps.map((s) => s.key)
    )
  })

  it("keeps step tones identical — tone drives the icon, not the translation", () => {
    expect(b.home.signature.steps.map((s) => s.tone)).toEqual(
      a.home.signature.steps.map((s) => s.tone)
    )
  })

  it("keeps the run strategies aligned, including their docs paths", () => {
    expect(b.home.run.strategies.map((s) => s.key)).toEqual(a.home.run.strategies.map((s) => s.key))
    expect(b.home.run.strategies.map((s) => s.docsPath)).toEqual(
      a.home.run.strategies.map((s) => s.docsPath)
    )
  })

  it("keeps the four task-level connections aligned", () => {
    expect(b.home.connections.items.map((i) => i.key)).toEqual(
      a.home.connections.items.map((i) => i.key)
    )
  })

  it("keeps the trust bento at four cards with matching keys", () => {
    expect(a.home.trust.cards).toHaveLength(4)
    expect(b.home.trust.cards.map((c) => c.key)).toEqual(a.home.trust.cards.map((c) => c.key))
  })

  it("keeps the workbench panels aligned", () => {
    expect(b.home.workbench.panels.map((p) => p.key)).toEqual(
      a.home.workbench.panels.map((p) => p.key)
    )
  })

  it("keeps footer columns and their link targets aligned", () => {
    expect(b.footer.columns).toHaveLength(a.footer.columns.length)
    a.footer.columns.forEach((column, index) => {
      const other = b.footer.columns[index]
      expect(other.links.map((l) => l.route ?? l.href ?? l.docsPath)).toEqual(
        column.links.map((l) => l.route ?? l.href ?? l.docsPath)
      )
    })
  })

  it("keeps nav routes aligned so both locales expose the same pages", () => {
    expect(b.nav.links.map((l) => l.route)).toEqual(a.nav.links.map((l) => l.route))
    expect(b.nav.productMenu.items.map((i) => i.route)).toEqual(
      a.nav.productMenu.items.map((i) => i.route)
    )
  })

  it("keeps product section anchors aligned across locales", () => {
    expect(b.product.sections.map((s) => s.id)).toEqual(a.product.sections.map((s) => s.id))
  })

  it("gives every nav dropdown anchor a section that actually carries that id", () => {
    // `/product#chat` with no `id="chat"` on the page is a link that silently
    // does nothing — the most common way an anchor menu rots.
    for (const copy of [a, b]) {
      const ids = new Set(copy.product.sections.map((s) => s.id).filter(Boolean))
      for (const item of copy.nav.productMenu.items) {
        const anchor = item.route.split("#")[1]
        expect(anchor).toBeTruthy()
        expect(ids.has(anchor)).toBe(true)
      }
    }
  })

  it("gives every footer product anchor a matching section id", () => {
    for (const copy of [a, b]) {
      const ids = new Set(copy.product.sections.map((s) => s.id).filter(Boolean))
      const anchors = copy.footer.columns
        .flatMap((column) => column.links)
        .map((link) => link.route)
        .filter((route): route is string => Boolean(route?.includes("#")))
        .map((route) => route.split("#")[1])
      expect(anchors.length).toBeGreaterThan(0)
      for (const anchor of anchors) expect(ids.has(anchor)).toBe(true)
    }
  })

  it("keeps evidence rows aligned by their source target", () => {
    expect(b.trust.evidence.rows.map((r) => r.href ?? r.docsPath)).toEqual(
      a.trust.evidence.rows.map((r) => r.href ?? r.docsPath)
    )
  })
})

describe("content governance", () => {
  const banned = [
    "production-ready",
    "enterprise-grade",
    "fully private",
    "everything stays local",
    "unlimited",
  ]

  it("never uses the phrases the spec forbids", () => {
    const serialized = JSON.stringify(getCopy("en")).toLowerCase()
    for (const phrase of banned) {
      expect(serialized).not.toContain(phrase)
    }
  })

  it("ships no empty link targets", () => {
    for (const locale of LOCALES) {
      const copy = getCopy(locale)
      for (const column of copy.footer.columns) {
        for (const link of column.links) {
          expect(link.route ?? link.href ?? link.docsPath).toBeTruthy()
          expect(link.label.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it("omits Roadmap and Community, which are not public surfaces", () => {
    const labels = getCopy("en")
      .footer.columns.flatMap((c) => c.links)
      .map((l) => l.label)
    expect(labels).not.toContain("Roadmap")
    expect(labels).not.toContain("Community")
  })
})

describe("format", () => {
  it("substitutes named placeholders", () => {
    expect(format("Step {current} of {total}", { current: 2, total: 6 })).toBe("Step 2 of 6")
  })

  it("leaves unknown placeholders untouched rather than printing undefined", () => {
    expect(format("as of {date}", {})).toBe("as of {date}")
  })

  it("substitutes every occurrence", () => {
    expect(format("{a} and {a}", { a: "x" })).toBe("x and x")
  })
})
