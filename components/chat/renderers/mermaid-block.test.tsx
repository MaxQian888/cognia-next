import { fireEvent, render, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MERMAID_AUTO_RENDER_MAX_CHARS, MermaidBlock } from "./mermaid-block"
import { act } from "@testing-library/react"
import { getCachedMermaid, renderMermaidCached } from "@cognia/mermaid"
import { __resetChatDiagramPaletteForTesting } from "@/lib/chat/diagram-palette"

jest.mock("@cognia/mermaid", () => ({
  getCachedMermaid: jest.fn(),
  renderMermaidCached: jest.fn(),
  // The real reader is a two-line class check; keeping it real is what lets
  // the dark-theme test below drive it through `document`.
  readMermaidTheme: () =>
    document.documentElement.classList.contains("dark") ? "dark" : "default",
}))

/** The render style every call carries: the app palette on the base theme. */
const STYLE = expect.objectContaining({
  key: expect.any(String),
  themeVariables: expect.objectContaining({ primaryTextColor: expect.any(String) }),
})

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

function renderInProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

/** Past the auto-render budget, so the block defers to a render button. */
const HUGE_SOURCE = `graph TD\n${"  a-->b\n".repeat(MERMAID_AUTO_RENDER_MAX_CHARS / 8)}`

describe("MermaidBlock", () => {
  beforeEach(() => {
    getCached.mockReset()
    renderCached.mockReset()
    document.documentElement.classList.remove("dark")
    document.documentElement.removeAttribute("style")
    __resetChatDiagramPaletteForTesting()
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

    // Cold: the frame is already there (no layout jump), but busy, not a figure.
    expect(container.querySelector('[role="figure"]')).toBeNull()
    expect(container.querySelector('[data-rich-block="mermaid"]')).toHaveAttribute(
      "aria-busy",
      "true"
    )

    await waitFor(() => {
      expect(container.querySelector('[role="figure"]')).toBeTruthy()
    })
    expect(container.innerHTML).toContain("fresh-diagram")
    expect(renderCached).toHaveBeenCalledWith("default", "graph LR; X-->Y", STYLE)
  })

  it("requests the dark theme when the global .dark class is set", async () => {
    document.documentElement.classList.add("dark")
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>dark</svg>")

    renderInProvider(<MermaidBlock content="pie" />)

    await waitFor(() => {
      expect(renderCached).toHaveBeenCalledWith(
        "dark",
        "pie",
        expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: true }) })
      )
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

  it("re-renders with the new palette when the theme flips", async () => {
    getCached.mockReturnValue(undefined)
    renderCached.mockResolvedValue("<svg>light</svg>")

    renderInProvider(<MermaidBlock content="pie" />)
    await waitFor(() => expect(renderCached).toHaveBeenCalledTimes(1))

    renderCached.mockResolvedValue("<svg>dark</svg>")
    await act(async () => {
      document.documentElement.classList.add("dark")
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(renderCached).toHaveBeenLastCalledWith(
        "dark",
        "pie",
        expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: true }) })
      )
    )
  })

  it("draws in the shared frame with a hover toolbar and zoomable fullscreen", async () => {
    getCached.mockReturnValue("<svg>cached</svg>")
    const { container, getByRole, findByTestId } = renderInProvider(
      <MermaidBlock content="graph TD; A-->B" />
    )
    const frame = container.querySelector('[data-rich-block="mermaid"]')!
    expect(frame).toHaveAttribute("role", "figure")
    expect(frame.querySelector("[data-message-rich-control]")).toBeTruthy()

    fireEvent.click(getByRole("button", { name: "showSource" }))
    expect(frame.querySelector("pre")).toHaveTextContent("graph TD; A-->B")

    fireEvent.click(getByRole("button", { name: "viewFullscreen" }))
    const canvas = await findByTestId("mermaid-fullscreen-canvas")
    expect(canvas).toHaveAttribute("data-zoom", "1")
    fireEvent.click(getByRole("button", { name: "zoomIn" }))
    expect(canvas).toHaveAttribute("data-zoom", "1.25")
    fireEvent.click(getByRole("button", { name: "zoomOut" }))
    fireEvent.click(getByRole("button", { name: "zoomOut" }))
    expect(canvas).toHaveAttribute("data-zoom", "0.75")
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
