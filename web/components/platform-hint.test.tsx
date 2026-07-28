import { render, screen } from "@testing-library/react"
import { en } from "@web/content/en"
import { zh } from "@web/content/zh"
import { PlatformHint } from "./platform-hint"

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}

function setMaxTouchPoints(value: number) {
  Object.defineProperty(navigator, "maxTouchPoints", { value, configurable: true })
}

const original = navigator.userAgent
const originalTouch = navigator.maxTouchPoints
afterEach(() => {
  setUserAgent(original)
  setMaxTouchPoints(originalTouch ?? 0)
})

describe("PlatformHint", () => {
  it("names the detected platform", () => {
    setUserAgent(MAC)
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.common.download.platformMacos)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(en.download.platformHint.label))).toBeInTheDocument()
  })

  it("follows the agent rather than a hard-coded guess", () => {
    setUserAgent(WINDOWS)
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.common.download.platformWindows)).toBeInTheDocument()
  })

  it("says so plainly when it cannot tell", () => {
    setUserAgent("curl/8.7.1")
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.download.platformHint.unknown)).toBeInTheDocument()
  })

  it("localises", () => {
    setUserAgent(MAC)
    render(<PlatformHint common={zh.common} copy={zh.download.platformHint} />)
    expect(screen.getByText(new RegExp(zh.download.platformHint.label))).toBeInTheDocument()
  })

  it("names Linux too", () => {
    setUserAgent(LINUX)
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.common.download.platformLinux)).toBeInTheDocument()
  })

  // iPadOS 13+ ships a desktop Safari UA on purpose. Without the touch check
  // the hint told a tablet it was running macOS and offered it a .dmg.
  it("declines to call an iPad a Mac", () => {
    setUserAgent(MAC)
    setMaxTouchPoints(5)
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.download.platformHint.unknown)).toBeInTheDocument()
    expect(screen.queryByText(en.common.download.platformMacos)).toBeNull()
  })

  it("still names a real Mac, which reports no touch points", () => {
    setUserAgent(MAC)
    setMaxTouchPoints(0)
    render(<PlatformHint common={en.common} copy={en.download.platformHint} />)
    expect(screen.getByText(en.common.download.platformMacos)).toBeInTheDocument()
  })

  it("gives each platform its own glyph rather than one shared mark", () => {
    const marks = new Set<string>()
    for (const ua of [MAC, WINDOWS, LINUX]) {
      setUserAgent(ua)
      setMaxTouchPoints(0)
      const { container, unmount } = render(
        <PlatformHint common={en.common} copy={en.download.platformHint} />
      )
      marks.add(container.querySelector("svg")?.getAttribute("class") ?? "")
      unmount()
    }
    // Three platforms, three distinct icons — a shared one carries no
    // information beyond the words already beside it.
    expect(marks.size).toBe(3)
  })

  it("keeps its mark out of the accessibility tree", () => {
    setUserAgent(MAC)
    const { container } = render(
      <PlatformHint common={en.common} copy={en.download.platformHint} />
    )
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg).toHaveAttribute("aria-hidden", "true")
    }
  })
})

// A static export has no request, so the first paint cannot know the platform.
describe("PlatformHint before mount", () => {
  it("shows the detecting line rather than appearing from nowhere", () => {
    jest.isolateModules(() => {
      jest.doMock("@web/hooks/use-has-mounted", () => ({ useHasMounted: () => false }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PlatformHint: Subject } = require("./platform-hint")
      render(<Subject common={en.common} copy={en.download.platformHint} />)
      expect(screen.getByText(en.common.download.detecting)).toBeInTheDocument()
    })
    jest.dontMock("@web/hooks/use-has-mounted")
  })
})
