import { render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { GLYPH_NAMES } from "@web/components/glyph"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"

let reduced = false
let inView = true
jest.mock("motion/react", () => {
  const passthrough = (tag: "div" | "ul" | "li") => {
    function Passthrough({ children, className }: { children: ReactNode; className?: string }) {
      const Tag = tag
      return <Tag className={className}>{children}</Tag>
    }
    return Passthrough
  }
  return {
    useReducedMotion: () => reduced,
    useInView: () => inView,
    useMotionValue: (value: number) => ({ get: () => value, set: jest.fn() }),
    useSpring: () => ({ on: () => jest.fn() }),
    motion: { div: passthrough("div"), ul: passthrough("ul"), li: passthrough("li") },
  }
})

import { CapabilityPanorama } from "./capability-panorama"

const DOCS = "https://docs.example.test"

function renderPanorama(locale: "en" | "zh" = "en") {
  const copy = locale === "en" ? en : zh
  return render(
    <CapabilityPanorama
      copy={copy.product.panorama}
      common={copy.common}
      locale={locale}
      docsOrigin={DOCS}
    />
  )
}

describe("CapabilityPanorama", () => {
  beforeEach(() => {
    reduced = false
    inView = true
  })

  it("renders its heading without an index tag, as a sub-page section", () => {
    const { container } = renderPanorama()
    expect(screen.getByRole("heading", { name: en.product.panorama.title })).toBeInTheDocument()
    expect(container.querySelector('[data-slot="section-index"]')).toBeNull()
  })

  it("no longer carries the build-time figures, which moved to the trust section", () => {
    const { container } = renderPanorama()
    expect(container.querySelector("[data-figure]")).toBeNull()
  })

  it("places every subsystem on a lane with its own mark and a next step", () => {
    const { container } = renderPanorama()
    const lanes = [...container.querySelectorAll("[data-lane]")].map((lane) =>
      lane.getAttribute("data-lane")
    )
    expect(lanes).toEqual(["work", "remember", "reach", "control"])
    for (const lane of en.product.panorama.lanes) {
      const region = container.querySelector(`[data-lane="${lane.key}"]`) as HTMLElement
      for (const item of lane.items) {
        expect(within(region).getByText(item.name)).toBeInTheDocument()
        expect(region.querySelector(`[data-glyph="${item.glyph}"]`)).toBeInTheDocument()
        expect(item.route || item.docsPath).toBeTruthy()
      }
    }
  })

  it("uses each bespoke mark at most once, and only marks that exist", () => {
    const used = en.product.panorama.lanes.flatMap((lane) => lane.items.map((item) => item.glyph))
    expect(new Set(used).size).toBe(used.length)
    for (const glyph of used) expect(GLYPH_NAMES).toContain(glyph)
  })

  it("draws the marks once on screen and leaves them complete under reduced motion", () => {
    const { container, unmount } = renderPanorama()
    expect(container.querySelectorAll("svg.glyph-draw").length).toBeGreaterThan(0)
    unmount()

    reduced = true
    const still = renderPanorama().container
    expect(still.querySelectorAll("svg.glyph-draw")).toHaveLength(0)
  })

  it("links a docs item to the documentation origin and a route item into the site", () => {
    renderPanorama()
    // Each link names its destination: the docs, or a page on this site.
    const docs = screen.getAllByRole("link", { name: new RegExp(en.common.learnMore) })
    expect(docs.every((link) => link.getAttribute("href")?.startsWith(DOCS))).toBe(true)
    const pages = screen.getAllByRole("link", { name: en.common.openPage })
    expect(pages.some((link) => link.getAttribute("href") === "/product#chat")).toBe(true)
    expect(pages.every((link) => !link.getAttribute("href")?.startsWith(DOCS))).toBe(true)
  })

  it("renders the Chinese copy with the same lanes", () => {
    const { container } = renderPanorama("zh")
    expect(screen.getByRole("heading", { name: zh.product.panorama.title })).toBeInTheDocument()
    expect(container.querySelectorAll("[data-lane]")).toHaveLength(4)
    expect(zh.product.panorama.lanes.map((lane) => lane.items.length)).toEqual(
      en.product.panorama.lanes.map((lane) => lane.items.length)
    )
  })
})
