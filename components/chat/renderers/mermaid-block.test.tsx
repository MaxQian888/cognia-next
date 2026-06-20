import { render, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MermaidBlock } from "./mermaid-block"
import { getCachedMermaid, renderMermaidCached } from "@/lib/mermaid/render-cache"

jest.mock("@/lib/mermaid/render-cache", () => ({
  getCachedMermaid: jest.fn(),
  renderMermaidCached: jest.fn(),
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

function renderInProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("MermaidBlock", () => {
  beforeEach(() => {
    getCached.mockReset()
    renderCached.mockReset()
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
})
