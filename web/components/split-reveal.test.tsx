let reduced = false
let inView = false

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduced,
  useInView: () => inView,
}))

import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { SplitReveal, splitStagger, splitWords, type SplitToken } from "./split-reveal"

const words = (tokens: SplitToken[]) =>
  tokens.map((token) => (token.kind === "word" ? token.text : " "))

function placeOnScreen(onScreen: boolean) {
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: onScreen ? 100 : 2000,
    bottom: onScreen ? 160 : 2060,
    left: 0,
    right: 600,
    width: 600,
    height: 60,
    x: 0,
    y: onScreen ? 100 : 2000,
    toJSON: () => ({}),
  })
}

beforeEach(() => {
  reduced = false
  inView = false
  placeOnScreen(false)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("splitWords", () => {
  it("splits Latin text into words and keeps the spaces between them", () => {
    expect(words(splitWords("Your open workspace for AI agents."))).toEqual([
      "Your",
      " ",
      "open",
      " ",
      "workspace",
      " ",
      "for",
      " ",
      "AI",
      " ",
      "agents.",
    ])
  })

  it("splits CJK per character and keeps embedded Latin words whole", () => {
    expect(words(splitWords("你的开放 AI Agent 工作空间。"))).toEqual([
      "你",
      "的",
      "开",
      "放",
      " ",
      "AI",
      " ",
      "Agent",
      " ",
      "工",
      "作",
      "空",
      "间。",
    ])
  })

  it("never lets closing punctuation start a unit, nor opening punctuation end one", () => {
    expect(words(splitWords("看「任务」，好。"))).toEqual(["看", "「任", "务」，", "好。"])
    expect(words(splitWords("Run (once), then stop."))).toEqual([
      "Run",
      " ",
      "(once),",
      " ",
      "then",
      " ",
      "stop.",
    ])
  })

  it("collapses runs of whitespace and trims the ends", () => {
    expect(words(splitWords("  one \n  two  "))).toEqual(["one", " ", "two"])
    expect(splitWords("")).toEqual([])
    expect(splitWords("   ")).toEqual([])
  })

  it("keeps a lone punctuation mark as a unit", () => {
    expect(words(splitWords("。"))).toEqual(["。"])
    expect(words(splitWords("「"))).toEqual(["「"])
  })

  it("loses no character of any real headline", () => {
    for (const title of [
      en.home.hero.title,
      zh.home.hero.title,
      en.home.film.title,
      zh.home.film.title,
    ]) {
      const joined = splitWords(title)
        .map((token) => (token.kind === "word" ? token.text : " "))
        .join("")
      expect(joined).toBe(title.trim().replace(/\s+/gu, " "))
    }
  })
})

describe("splitStagger", () => {
  it("staggers short headlines by 45ms and caps a long one's cascade at 360ms", () => {
    expect(splitStagger(0)).toBe(0)
    expect(splitStagger(1)).toBe(0)
    expect(splitStagger(6)).toBeCloseTo(0.045)
    expect(splitStagger(16) * 15).toBeCloseTo(0.36)
  })
})

describe("SplitReveal", () => {
  it("names the heading with its plain title and hides the split copy from assistive technology", () => {
    const { container } = render(<SplitReveal as="h1" text="Your open workspace." />)
    expect(
      screen.getByRole("heading", { level: 1, name: "Your open workspace." })
    ).toBeInTheDocument()
    const visual = container.querySelector('[aria-hidden="true"]')
    expect(visual?.textContent).toBe("Your open workspace.")
    // The title is the heading's text exactly once, for snippets and copy-paste.
    expect(container.querySelector("h1")?.textContent).toBe("Your open workspace.")
  })

  it("renders each unit in a mask with its own delay in the cascade", () => {
    const { container } = render(<SplitReveal text="One task end to end." />)
    const units = [...container.querySelectorAll<HTMLElement>("[data-split-word]")]
    expect(units.map((unit) => unit.textContent)).toEqual(["One", "task", "end", "to", "end."])
    expect(units.every((unit) => unit.parentElement?.classList.contains("split-mask"))).toBe(true)
    expect(units.map((unit) => unit.style.getPropertyValue("--split-delay"))).toEqual([
      "0ms",
      "45ms",
      "90ms",
      "135ms",
      "180ms",
    ])
  })

  it("mount: runs from the first render, after a short lead, whatever the viewport or preference", () => {
    reduced = true
    const { container } = render(
      <SplitReveal as="h1" trigger="mount" text="Your open workspace." />
    )
    const heading = container.querySelector("h1")
    expect(heading).toHaveAttribute("data-split", "run")
    expect(
      container
        .querySelector<HTMLElement>("[data-split-word]")
        ?.style.getPropertyValue("--split-delay")
    ).toBe("50ms")
  })

  it("view: arms a heading that is off screen, then runs it when it scrolls in", () => {
    const { container, rerender } = render(<SplitReveal text="Watch one task." />)
    const heading = container.querySelector("h2")
    expect(heading).toHaveAttribute("data-split", "armed")
    inView = true
    rerender(<SplitReveal text="Watch one task." />)
    expect(heading).toHaveAttribute("data-split", "run")
  })

  it("view: never hides a heading the reader can already see", () => {
    placeOnScreen(true)
    const { container } = render(<SplitReveal text="Watch one task." />)
    expect(container.querySelector("h2")).toHaveAttribute("data-split", "static")
  })

  it("view: never arms under reduced motion", () => {
    reduced = true
    const { container } = render(<SplitReveal text="Watch one task." />)
    expect(container.querySelector("h2")).toHaveAttribute("data-split", "static")
  })

  it("passes its class to the heading element", () => {
    const { container } = render(<SplitReveal text="Title" className="text-5xl" />)
    expect(container.querySelector("h2")).toHaveClass("text-5xl")
  })
})
