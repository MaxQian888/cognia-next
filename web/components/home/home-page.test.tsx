const FILM = {
  src: "/video/product-film-en.abc.mp4",
  poster: "/video/product-film-en.abc.jpg",
  width: 1920,
  height: 1080,
  bytes: 6_000_000,
  durationS: 44,
  captions: "/video/product-film-en.abc.vtt",
  hasAudio: true,
}
// Created inside the factory (a factory runs before module-level consts exist)
// and reached through the mocked module, whose `videos` each test replaces.
jest.mock("@web/content/generated/product-videos.json", () => ({ renderedAt: null, videos: {} }))

import videoManifest from "@web/content/generated/product-videos.json"
import { render, screen, within } from "@testing-library/react"
import { Children, isValidElement } from "react"
import { evidence } from "@web/components/site-shell"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { TrustSection } from "./trust-section"
import { HomePage } from "./home-page"

jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: jest.fn() }),
}))

jest.mock("motion/react", () => ({
  useReducedMotion: () => true,
  useInView: () => true,
  useScroll: () => ({ scrollYProgress: 0 }),
  useMotionValue: (value: number) => ({ get: () => value, set: jest.fn() }),
  useSpring: () => ({ on: () => jest.fn() }),
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
}))

function mockVideos(): { videos: Record<string, unknown> } {
  return videoManifest as unknown as { videos: Record<string, unknown> }
}

beforeEach(() => {
  mockVideos().videos = { "product-film-en": FILM }
})

describe("HomePage", () => {
  it.each(["en", "zh"] as const)(
    "hands the trust section the evidence snapshot and the counted-figure labels in %s",
    (locale) => {
      // Inspect the server-produced props: the trust section is a server
      // component, so the snapshot it reads never crosses into the client.
      const page = HomePage({ locale })
      const trust = Children.toArray(page.props.children).find(
        (child) => isValidElement(child) && child.type === TrustSection
      )
      expect(isValidElement(trust)).toBe(true)
      if (!isValidElement(trust)) throw new Error("Missing trust section")
      const copy = locale === "en" ? en : zh
      expect(trust.props).toHaveProperty("evidence", evidence)
      expect(trust.props).toHaveProperty("inventoryCopy", copy.inventory)
    }
  )

  it("renders all eight sections in the order the spec fixes", () => {
    render(<HomePage locale="en" />)
    const headings = screen
      .getAllByRole("heading", { level: 1 })
      .concat(screen.getAllByRole("heading", { level: 2 }))
      .map((h) => h.textContent)

    const expected = [
      en.home.hero.title,
      en.home.signature.title,
      en.home.workbench.title,
      en.home.desktop.title,
      en.home.run.title,
      en.home.trust.title,
      en.home.faq.title,
      en.home.finalCta.title,
    ]
    for (const title of expected) {
      expect(headings).toContain(title)
    }
    // In that order, not merely present.
    const positions = expected.map((title) => headings.indexOf(title))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("numbers every section from 01 to 08 in document order", () => {
    const { container } = render(<HomePage locale="en" />)
    const tags = [...container.querySelectorAll('[data-slot="section-index"]')].map(
      (tag) => tag.textContent
    )
    expect(tags).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"])
  })

  it("opens the task section on the film, right after the hero, never autoplaying", () => {
    const { container } = render(<HomePage locale="en" />)
    expect(container.querySelector("section#film")).toBeNull()
    const task = container.querySelector("section#task")
    expect(task?.previousElementSibling).toHaveAttribute("id", "hero")
    expect(task?.querySelector('[data-slot="task-film"] video')).toHaveAttribute("preload", "none")
  })

  it("keeps the eight sections and opens the task on its steps when the film is not rendered", () => {
    mockVideos().videos = {}
    const { container } = render(<HomePage locale="en" />)
    expect(container.querySelector('[data-slot="task-film"]')).toBeNull()
    expect(screen.queryByText(en.home.signature.stepsLabel)).toBeNull()
    const tags = [...container.querySelectorAll('[data-slot="section-index"]')].map(
      (tag) => tag.textContent
    )
    expect(tags).toHaveLength(8)
  })

  it("has no scrolling strip between the hero and the task", () => {
    const { container } = render(<HomePage locale="en" />)
    expect(container.querySelector("#hero + aside")).toBeNull()
    expect(container.querySelector('[class*="animate-marquee"]')).toBeNull()
  })

  it("advances one signature task, never a second scenario", () => {
    render(<HomePage locale="en" />)
    expect(screen.getByText(en.home.signature.task)).toBeInTheDocument()
  })

  it("leaves the device handoff, connections and subsystem map to their sub-pages", () => {
    const { container } = render(<HomePage locale="en" />)
    for (const id of ["entries", "connections", "system"]) {
      expect(container.querySelector(`#${id}`)).toBeNull()
    }
    // Each still has a way in from the homepage.
    const strip = container.querySelector('[data-slot="surfaces-strip"]') as HTMLElement
    expect(
      within(strip).getByRole("link", { name: en.home.desktop.otherSurfaces.linkLabel })
    ).toHaveAttribute("href", "/surfaces")
  })

  it("links the signature task to both scenario pages", () => {
    const { container } = render(<HomePage locale="en" />)
    const row = container.querySelector('[data-slot="use-case-links"]') as HTMLElement
    expect(row.closest("section")).toHaveAttribute("id", "task")
    for (const item of en.nav.useCasesMenu.items) {
      expect(within(row).getByRole("link", { name: new RegExp(item.label) })).toHaveAttribute(
        "href",
        item.route
      )
    }
  })

  it("answers the open questions before the close", () => {
    const { container } = render(<HomePage locale="en" />)
    const faq = container.querySelector("section#faq")
    expect(faq?.nextElementSibling).toHaveAttribute("id", "start")
    expect(faq?.querySelectorAll("details")).toHaveLength(en.home.faq.items.length)
  })

  it("wraps the page in the shared shell", () => {
    const { container } = render(<HomePage locale="en" />)
    // Two navigation landmarks, each named: the site header and the reading
    // position rail. Both are genuinely sets of links for getting somewhere,
    // which is what the role is for — so they are queried by name rather than
    // collapsed into one.
    expect(screen.getByRole("navigation", { name: en.nav.productMenu.label })).toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: en.nav.sectionIndexLabel })).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="scroll-progress"]')).toBeInTheDocument()
  })

  it("indexes every section it renders, with a live anchor for each", () => {
    // The rail, the ids and the labels are one fact: a section that gains an
    // id but no label — or a label with no section — shows up here.
    const { container } = render(<HomePage locale="en" />)
    const rail = screen.getByRole("navigation", { name: en.nav.sectionIndexLabel })
    for (const [id, label] of Object.entries(en.home.sectionIndex)) {
      const link = within(rail).getByRole("link", { name: label })
      expect(link).toHaveAttribute("href", `#${id}`)
      expect(container.querySelector(`#${id}`)).toBeInTheDocument()
    }
  })

  it("keeps the language switcher on the homepage route", () => {
    render(<HomePage locale="en" />)
    expect(screen.getAllByRole("link", { name: "中文" })[0]).toHaveAttribute("href", "/zh")
  })

  it("renders the Chinese homepage end to end", () => {
    render(<HomePage locale="zh" />)
    expect(screen.getByRole("heading", { level: 1, name: zh.home.hero.title })).toBeInTheDocument()
    expect(screen.getByText(zh.home.signature.task)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: zh.home.finalCta.title })).toBeInTheDocument()
  })
})
