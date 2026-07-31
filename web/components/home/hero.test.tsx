import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ReleaseState } from "@web/lib/evidence"
import { Hero } from "./hero"

jest.mock("motion/react", () => ({
  useReducedMotion: () => true,
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
}))

const releaseState: ReleaseState = {
  hasRelease: false,
  version: null,
  publishedAt: null,
  htmlUrl: "https://github.com/MaxQian888/cognia-next/releases",
  byPlatform: { macos: [], windows: [], linux: [] },
}

function renderHero(locale: "en" | "zh" = "en") {
  return render(
    <Hero
      locale={locale}
      copy={locale === "en" ? en : zh}
      releaseState={releaseState}
      docsOrigin="https://docs.cognia.example"
    />
  )
}

describe("Hero", () => {
  it("states the product category and the claim", () => {
    renderHero()
    expect(screen.getByText(en.home.hero.eyebrow)).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: en.home.hero.title })).toBeInTheDocument()
  })

  it("carries exactly one h1", () => {
    const { container } = renderHero()
    expect(container.querySelectorAll("h1")).toHaveLength(1)
  })

  it("renders the outcome subtitle", () => {
    renderHero()
    expect(screen.getByText(en.home.hero.subtitle)).toBeInTheDocument()
  })

  it("offers the primary and secondary actions, and no third same-level CTA", () => {
    renderHero()
    expect(screen.getByRole("link", { name: en.common.download.unavailable })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: en.common.viewSource })).toBeInTheDocument()
  })

  it("renders the trust rail as four labelled cells with qualifying detail", () => {
    renderHero()
    for (const item of en.home.hero.trustRail) {
      expect(screen.getByText(item.label)).toBeInTheDocument()
      expect(screen.getByText(item.detail)).toBeInTheDocument()
    }
  })

  it("puts a product stage in the first screen with a described visual", () => {
    renderHero()
    expect(screen.getByRole("img", { name: en.home.hero.stageAlt })).toBeInTheDocument()
    expect(screen.getByText(en.home.hero.stageCaption)).toBeInTheDocument()
  })

  it("localises the whole hero", () => {
    renderHero("zh")
    expect(screen.getByRole("heading", { level: 1, name: zh.home.hero.title })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: zh.common.download.unavailable })).toHaveAttribute(
      "href",
      "/zh/download"
    )
  })
})
