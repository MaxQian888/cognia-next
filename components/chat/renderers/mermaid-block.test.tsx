import { fireEvent, render, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MERMAID_AUTO_RENDER_MAX_CHARS, MermaidBlock } from "./mermaid-block"
import { getCachedMermaid, renderMermaidCached, subscribeMermaidTheme } from "@cognia/mermaid"

jest.mock("@cognia/mermaid", () => ({
  getCachedMermaid: jest.fn(),
  renderMermaidCached: jest.fn(),
  // The real reader is a two-line class check; keeping it real is what lets
  // the dark-theme test below drive it through `document`.
  readMermaidTheme: () =>
    document.documentElement.classList.contains("dark") ? "dark" : "default",
  subscribeMermaidTheme: jest.fn(() => () => {}),
}))

// `MermaidBlock`'s render callback depends on the next-intl translator `t`.
// Production next-intl returns a referentially-stable `t`, but the global test
// mock builds a fresh one per render, which would spin the render effect into a
// loop on the async (cold) path. Pin a stable translator for this file.
jest.mock("next-intl", () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})

const getCached = getCachedMermaid as jest.MockedFunction<typeof getCachedMermaid>
const renderCached = renderMermaidCached as jest.MockedFunction<typeof renderMermaidCached>
const subscribeTheme = subscribeMermaidTheme as jest.MockedFunction<typeof subscribeMermaidTheme>

function renderInProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

/** Past the auto-render budget, so the block defers to a render button. */
const HUGE_SOURCE = `graph TD\n${"  a-->b\n".repeat(MERMAID_AUTO_RENDER_MAX_CHARS / 8)}`

describe("MermaidBlock", () => {
  beforeEach(() => {
    getCached.mockReset()
    renderCached.mockReset()
    subscribeTheme.mockReset()
    subscribeTheme.mockReturnValue(() => {})
    document.documentElement.classList.remove("dark")
  })

  it("paints synchronously from cache with no Skeleton flash (remount path)", () => {
    getCached.mockReturnValue("<svg>cached-diagram</svg>")

    const { container } = renderInProvider(<MermaidBlock content="graph TD; A-->B" />)

    // Diagram figure present on the first frame; loading Skeleton never shows.
    expect(container.querySelector('[role="figure"]')).toBeTruthy()
    expect(container.innerHTML).toContain("cached-diagram")
    // Cache hit means the expensive render is skipped entirely.
    expect(renderCached).not.toHaveBeenCalled()
  })

  it("shows a Skeleton for a cold diagram, then the rendered SVG", async () => {
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>fresh-diagram</svg>")

    const { container } = renderInProvider(<MermaidBlock content="graph LR; X-->Y" />)

    // Cold: no figure yet (Skeleton branch).
    expect(container.querySelector('[role="figure"]')).toBeNull()

    await waitFor(() => {
      expect(container.querySelector('[role="figure"]')).toBeTruthy()
    })
    expect(container.innerHTML).toContain("fresh-diagram")
    expect(renderCached).toHaveBeenCalledWith("default", "graph LR; X-->Y")
  })

  it("requests the dark theme when the global .dark class is set", async () => {
    document.documentElement.classList.add("dark")
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>dark</svg>")

    renderInProvider(<MermaidBlock content="pie" />)

    await waitFor(() => {
      expect(renderCached).toHaveBeenCalledWith("dark", "pie")
    })
  })

  it("renders an error affordance when rendering fails", async () => {
    getCached.mockReturnValue(undefined)
    renderCached.mockRejectedValue(new Error("bad syntax"))

    const { container, getByText } = renderInProvider(<MermaidBlock content="oops" />)

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy()
    })
    expect(getByText("bad syntax")).toBeInTheDocument()
  })

  it("subscribes to the shared theme watcher instead of owning an observer", () => {
    getCached.mockReturnValue("<svg>cached</svg>")

    const unsubscribe = jest.fn()
    subscribeTheme.mockReturnValue(unsubscribe)
    const { unmount } = renderInProvider(<MermaidBlock content="graph TD; A-->B" />)

    expect(subscribeTheme).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("re-renders when the shared watcher reports a theme flip", async () => {
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>light</svg>")
    let notify: (() => void) | undefined
    subscribeTheme.mockImplementation((listener) => {
      notify = () => listener("dark")
      return () => {}
    })

    renderInProvider(<MermaidBlock content="pie" />)
    await waitFor(() => expect(renderCached).toHaveBeenCalledTimes(1))

    document.documentElement.classList.add("dark")
    renderCached.mockResolvedValue("<svg>dark</svg>")
    notify!()

    await waitFor(() => expect(renderCached).toHaveBeenCalledWith("dark", "pie"))
  })

  it("defers a diagram past the auto-render budget instead of laying it out", () => {
    getCached.mockReturnValue(undefined)

    const { container, getByRole } = renderInProvider(<MermaidBlock content={HUGE_SOURCE} />)

    expect(renderCached).not.toHaveBeenCalled()
    expect(container.querySelector('[role="figure"]')).toBeNull()
    expect(getByRole("button", { name: "renderAnyway" })).toBeInTheDocument()
    // The source is still readable while deferred — nothing is hidden.
    expect(container.querySelector("code")?.textContent).toContain("graph TD")
  })

  it("renders the deferred diagram once the reader asks for it", async () => {
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>big-diagram</svg>")

    const { container, getByRole } = renderInProvider(<MermaidBlock content={HUGE_SOURCE} />)
    fireEvent.click(getByRole("button", { name: "renderAnyway" }))

    await waitFor(() => {
      expect(container.querySelector('[role="figure"]')).toBeTruthy()
    })
    expect(container.innerHTML).toContain("big-diagram")
  })

  it("paints an oversized diagram straight from cache without asking", () => {
    // A remount of something already rendered costs nothing — the budget
    // exists to avoid the layout, not to hide cached output.
    getCached.mockReturnValue("<svg>cached-big</svg>")

    const { container, queryByRole } = renderInProvider(<MermaidBlock content={HUGE_SOURCE} />)

    expect(queryByRole("button", { name: "renderAnyway" })).toBeNull()
    expect(container.innerHTML).toContain("cached-big")
  })
})
