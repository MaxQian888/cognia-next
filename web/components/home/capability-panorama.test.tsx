import { render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { GLYPH_NAMES } from "@web/components/glyph"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { Evidence } from "@web/lib/evidence"
import { INVENTORY_KEYS } from "@web/lib/evidence"

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

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    readAt: "2026-09-05T00:00:00.000Z",
    lastGoodReadAt: "2026-09-05T00:00:00.000Z",
    errors: [],
    repo: { stars: 53, license: "AGPL-3.0", description: null },
    contributors: 3,
    releases: [],
    changesets: [],
    inventory: {
      plugins: 59,
      connectors: 11,
      workflowNodeKinds: 185,
      crates: 35,
      packages: 32,
      adrs: 167,
      testFiles: 9496,
    },
    ...overrides,
  }
}

function renderPanorama(locale: "en" | "zh" = "en", data: Evidence = evidence()) {
  const copy = locale === "en" ? en : zh
  return render(
    <CapabilityPanorama
      copy={copy.home.panorama}
      common={copy.common}
      evidence={data}
      locale={locale}
      docsOrigin={DOCS}
      index={8}
    />
  )
}

describe("CapabilityPanorama", () => {
  beforeEach(() => {
    reduced = false
    inView = true
  })

  it("shows one figure per inventory key, labelled, in display order", () => {
    const { container } = renderPanorama()
    const cells = [...container.querySelectorAll("[data-figure]")].map((cell) =>
      cell.getAttribute("data-figure")
    )
    expect(cells).toEqual([...INVENTORY_KEYS])
    for (const key of INVENTORY_KEYS) {
      expect(screen.getByText(en.home.panorama.figures[key])).toBeInTheDocument()
    }
    expect(screen.getByText("08")).toBeInTheDocument()
  })

  it("shows a dash rather than a zero when a count did not run", () => {
    const data = evidence()
    data.inventory.crates = 0
    const { container } = renderPanorama("en", data)
    const cell = container.querySelector('[data-figure="crates"]') as HTMLElement
    expect(within(cell).getByText("—")).toBeInTheDocument()
  })

  it("places every subsystem on a lane with its own mark and a next step", () => {
    const { container } = renderPanorama()
    const lanes = [...container.querySelectorAll("[data-lane]")].map((lane) =>
      lane.getAttribute("data-lane")
    )
    expect(lanes).toEqual(["work", "remember", "reach", "control"])
    for (const lane of en.home.panorama.lanes) {
      const region = container.querySelector(`[data-lane="${lane.key}"]`) as HTMLElement
      for (const item of lane.items) {
        expect(within(region).getByText(item.name)).toBeInTheDocument()
        expect(region.querySelector(`[data-glyph="${item.glyph}"]`)).toBeInTheDocument()
        expect(item.route || item.docsPath).toBeTruthy()
      }
    }
  })

  it("uses each bespoke mark at most once, and only marks that exist", () => {
    const used = en.home.panorama.lanes.flatMap((lane) => lane.items.map((item) => item.glyph))
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
    const links = screen.getAllByRole("link", { name: en.common.learnMore })
    expect(links.some((link) => link.getAttribute("href")?.startsWith(DOCS))).toBe(true)
    expect(links.some((link) => link.getAttribute("href") === "/product#chat")).toBe(true)
  })

  it("renders the Chinese copy with the same lanes", () => {
    const { container } = renderPanorama("zh")
    expect(screen.getByText(zh.home.panorama.title)).toBeInTheDocument()
    expect(container.querySelectorAll("[data-lane]")).toHaveLength(4)
    expect(zh.home.panorama.lanes.map((lane) => lane.items.length)).toEqual(
      en.home.panorama.lanes.map((lane) => lane.items.length)
    )
  })
})
