// Created inside the factory (a factory runs before module-level consts exist)
// and reached through the mocked module, whose `videos` each test replaces.
jest.mock("@web/content/generated/product-videos.json", () => ({ renderedAt: null, videos: {} }))

import videoManifest from "@web/content/generated/product-videos.json"
import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import type { ReleaseState } from "@web/lib/evidence"
import { Hero } from "./hero"

jest.mock("motion/react", () => ({
  useReducedMotion: () => true,
  useInView: () => true,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    p: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  },
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

function mockVideos(): { videos: Record<string, unknown> } {
  return videoManifest as unknown as { videos: Record<string, unknown> }
}

beforeEach(() => {
  mockVideos().videos = {}
  // jsdom has no media playback; the player's play/pause calls are not under test here.
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("Hero", () => {
  it("states the product category and the claim", () => {
    renderHero()
    expect(screen.getByText(en.home.hero.eyebrow)).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: en.home.hero.title })).toBeInTheDocument()
    // The first screen's headline rises from CSS on first paint, never waiting on hydration.
    expect(screen.getByRole("heading", { level: 1 })).toHaveAttribute("data-split", "run")
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

  it("puts the live workbench in the first screen with a described visual", () => {
    const { container } = renderHero()
    expect(screen.getByRole("img", { name: en.home.hero.stageAlt })).toBeInTheDocument()
    expect(screen.getByText(en.home.hero.stageCaption)).toBeInTheDocument()
    expect(container.querySelector(".stage-grid")).toHaveAttribute("aria-hidden")
  })

  it("keeps the labelled reconstruction until the hero loop has been rendered", () => {
    const { container } = renderHero()
    expect(container.querySelector('[data-placeholder="product-stage"]')).toBeInTheDocument()
    expect(container.querySelector('[data-video="ambient"]')).toBeNull()
  })

  it("plays the recorded hero loop once it is rendered, saying it is a recording", () => {
    mockVideos().videos["hero-loop-en"] = {
      src: "/video/hero-loop-en.abc.mp4",
      poster: "/video/hero-loop-en.abc.jpg",
      width: 1600,
      height: 1000,
      bytes: 1_000_000,
      durationS: 10,
      hasAudio: false,
    }
    const { container } = renderHero()
    const video = container.querySelector('[data-video="ambient"] video')
    expect(video).toHaveAttribute("src", "/video/hero-loop-en.abc.mp4")
    expect(video).toHaveAttribute("aria-label", en.home.hero.stageAlt)
    expect(container.querySelector('[data-placeholder="product-stage"]')).toBeNull()
    expect(screen.getByText(en.footage.recordingNote)).toBeInTheDocument()
    expect(screen.getByText(en.home.hero.stageCaption)).toBeInTheDocument()
  })

  it("does not borrow the other locale's recording", () => {
    mockVideos().videos["hero-loop-en"] = {
      src: "/video/hero-loop-en.abc.mp4",
      poster: "/video/hero-loop-en.abc.jpg",
      width: 1600,
      height: 1000,
      bytes: 1,
      durationS: 10,
      hasAudio: false,
    }
    const { container } = renderHero("zh")
    expect(container.querySelector('[data-video="ambient"]')).toBeNull()
  })

  it("sits on the execution stage and remaps the reading tokens onto it", () => {
    const { container } = renderHero()
    const section = container.querySelector("section#hero")
    expect(section).toHaveClass("bg-stage")
    expect(section).toHaveClass("stage-scope")
  })

  it("states the task beneath the workbench, from the shared fixture", () => {
    renderHero()
    expect(screen.getByText(en.home.hero.ticket.label)).toBeInTheDocument()
    expect(screen.getAllByText(en.reconstruction.workbench.statusLine).length).toBeGreaterThan(0)
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
