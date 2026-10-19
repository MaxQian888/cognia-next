import { LOCALES, ROUTES } from "@web/lib/locale"
import { format, getCopy } from "./index"
import { HOME_SECTIONS } from "./types"

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

  it("gives every homepage section a rail label, and no extras", () => {
    // The rail's labels, the `id` each section renders and this record are one
    // fact, not three. Without this, adding a section silently produces a rail
    // entry with an `undefined` label — or a rail that points at no anchor.
    for (const copy of [a, b]) {
      expect(Object.keys(copy.home.sectionIndex).sort()).toEqual([...HOME_SECTIONS].sort())
    }
  })

  it("keeps the closing index rows aligned by key, since the key selects the value", () => {
    expect(b.home.finalCta.rows.map((r) => r.key)).toEqual(a.home.finalCta.rows.map((r) => r.key))
  })

  it("gives both use-case pages a described stage", () => {
    for (const copy of [a, b]) {
      for (const variant of ["development", "research"] as const) {
        expect(copy.useCases[variant].stageAlt.length).toBeGreaterThan(0)
        expect(copy.useCases[variant].stageCaption.length).toBeGreaterThan(0)
      }
    }
  })

  it("translates every new label rather than leaving English in the zh bundle", () => {
    // A copy-paste that leaves the English string in `zh.ts` type-checks
    // perfectly, so it has to be caught here.
    expect(b.common.onThisPage).not.toBe(a.common.onThisPage)
    expect(b.common.copyCommand).not.toBe(a.common.copyCommand)
    expect(b.nav.sectionIndexLabel).not.toBe(a.nav.sectionIndexLabel)
    expect(b.home.finalCta.indexLabel).not.toBe(a.home.finalCta.indexLabel)
    expect(b.home.hero.ticket.label).not.toBe(a.home.hero.ticket.label)
    for (const key of ["label", "lead", "videoLabel", "playLabel", "captionsLabel"] as const) {
      expect(b.home.film[key]).not.toBe(a.home.film[key])
    }
    expect(b.footage.captureNote).not.toBe(a.footage.captureNote)
    expect(b.footage.recordingNote).not.toBe(a.footage.recordingNote)
    expect(b.home.signature.stepsLabel).not.toBe(a.home.signature.stepsLabel)
    expect(b.home.run.approvalShared).not.toBe(a.home.run.approvalShared)
    expect(b.home.finalCta.buildLabel).not.toBe(a.home.finalCta.buildLabel)
    for (const key of ["eyebrow", "title", "body"] as const) {
      expect(b.common.pageClose[key]).not.toBe(a.common.pageClose[key])
    }
  })

  it("labels the film with its render's length in both locales", () => {
    for (const copy of [a, b]) expect(copy.home.film.label).toContain("{seconds}")
  })

  it("gives every homepage section an eyebrow in both locales", () => {
    for (const copy of [a, b]) {
      const home = copy.home
      for (const eyebrow of [
        home.hero.eyebrow,
        home.signature.eyebrow,
        home.workbench.eyebrow,
        home.desktop.eyebrow,
        home.run.eyebrow,
        home.trust.eyebrow,
        home.faq.eyebrow,
        home.finalCta.eyebrow,
      ]) {
        expect(eyebrow.length).toBeGreaterThan(0)
      }
    }
  })

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
    expect(b.plugins.connections.items.map((i) => i.key)).toEqual(
      a.plugins.connections.items.map((i) => i.key)
    )
  })

  it("keeps the questions aligned by key, each with an answer and a destination", () => {
    expect(b.home.faq.items.map((i) => i.key)).toEqual(a.home.faq.items.map((i) => i.key))
    for (const copy of [a, b]) {
      for (const item of copy.home.faq.items) {
        expect(item.answer.length).toBeGreaterThan(0)
        expect(item.link).toBeDefined()
      }
      // The availability answer points at the page that reads the release
      // state; it must never assert the state itself, which would go stale.
      const install = copy.home.faq.items.find((i) => i.key === "install")
      expect(install?.link?.route).toBe("/download")
    }
  })

  it("keeps the surfaces page aligned with its station rail", () => {
    for (const copy of [a, b]) {
      expect(copy.surfaces.sections.map((s) => s.id)).toEqual(
        copy.surfaces.entryPoints.stations.map((s) => s.key)
      )
      expect(copy.surfaces.flow.steps).toHaveLength(4)
    }
    expect(b.surfaces.flow.steps.map((s) => s.docsPath)).toEqual(
      a.surfaces.flow.steps.map((s) => s.docsPath)
    )
    expect(b.surfaces.sections.flatMap((s) => s.entries.map((e) => e.docsPath))).toEqual(
      a.surfaces.sections.flatMap((s) => s.entries.map((e) => e.docsPath))
    )
  })

  it("routes both navigation menus to pages that exist", () => {
    for (const copy of [a, b]) {
      expect(copy.nav.useCasesMenu.items.map((i) => i.route)).toEqual([
        "/use-cases/development",
        "/use-cases/research",
      ])
      expect(copy.nav.productMenu.items.map((i) => i.route)).toContain("/surfaces")
    }
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
    // A menu entry without an anchor is a whole page, and has to be one the
    // site publishes.
    for (const copy of [a, b]) {
      const ids = new Set(copy.product.sections.map((s) => s.id).filter(Boolean))
      for (const item of copy.nav.productMenu.items) {
        const [path, anchor] = item.route.split("#")
        if (anchor === undefined) {
          expect(ROUTES as readonly string[]).toContain(path)
          continue
        }
        expect(path).toBe("/product")
        expect(ids.has(anchor)).toBe(true)
      }
    }
  })

  it("gives every footer product anchor a matching section id", () => {
    for (const copy of [a, b]) {
      // Each anchored route must land on an id its page renders: /product's
      // section ids, or the homepage's section ids (the FAQ link).
      const idsByPath: Record<string, Set<string>> = {
        "/product": new Set(copy.product.sections.map((s) => s.id).filter(Boolean) as string[]),
        "/": new Set<string>(HOME_SECTIONS),
      }
      const anchored = copy.footer.columns
        .flatMap((column) => column.links)
        .map((link) => link.route)
        .filter((route): route is string => Boolean(route?.includes("#")))
        .map((route) => route.split("#") as [string, string])
      expect(anchored.length).toBeGreaterThan(0)
      for (const [path, anchor] of anchored) expect(idsByPath[path]?.has(anchor)).toBe(true)
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
