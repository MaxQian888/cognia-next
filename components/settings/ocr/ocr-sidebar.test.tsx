import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrSidebar, OCR_AUTO_ROUTER_ID, type OcrSidebarProvider } from "./ocr-sidebar"

const SAMPLE: OcrSidebarProvider[] = [
  {
    id: "mistral-ocr",
    name: "Mistral OCR",
    subtitle: "Document OCR (cloud)",
    status: "connected",
    category: "document-cloud",
  },
  {
    id: "ocrs",
    name: "ocrs (local)",
    subtitle: "On-device",
    status: "ready",
    category: "local",
  },
  {
    id: "anthropic-vision",
    name: "Claude (vision)",
    subtitle: "LLM vision (cloud)",
    status: "not-configured",
    category: "llm-vision",
  },
]

function setup(overrides: Partial<React.ComponentProps<typeof OcrSidebar>> = {}) {
  const onSelect = jest.fn()
  const onSearchChange = jest.fn()
  const onCategoryChange = jest.fn()
  const onClearCache = jest.fn()
  const utils = render(
    <OcrSidebar
      providers={SAMPLE}
      autoRouterSubtitle="auto → Mistral OCR"
      selectedId={OCR_AUTO_ROUTER_ID}
      onSelect={onSelect}
      searchQuery=""
      onSearchChange={onSearchChange}
      categoryFilter="all"
      onCategoryChange={onCategoryChange}
      onClearCache={onClearCache}
      stats={{ enabled: 2, local: 1, cloud: 2 }}
      {...overrides}
    />
  )
  return { ...utils, onSelect, onSearchChange, onCategoryChange, onClearCache }
}

describe("OcrSidebar", () => {
  it("renders the Auto-Router pinned item first", () => {
    setup()
    const auto = screen.getByTestId("ocr-auto-router-item")
    expect(auto).toBeInTheDocument()
    expect(auto).toHaveTextContent(/Auto-Router/i)
  })

  it("renders every supplied provider in order", () => {
    setup()
    // Mistral OCR (label) is the first row name; ocrs the second; anthropic third.
    expect(screen.getByText("Mistral OCR")).toBeInTheDocument()
    expect(screen.getByText("ocrs (local)")).toBeInTheDocument()
    expect(screen.getByText("Claude (vision)")).toBeInTheDocument()
  })

  it("propagates search input to onSearchChange", async () => {
    const user = userEvent.setup()
    const { onSearchChange } = setup()
    const input = screen.getByLabelText(/Search OCR providers/i)
    await user.type(input, "claude")
    // userEvent types one character at a time — last call should hold full word
    expect(onSearchChange).toHaveBeenCalled()
  })

  it("propagates category tab clicks", async () => {
    const user = userEvent.setup()
    const { onCategoryChange } = setup()
    await user.click(screen.getByRole("tab", { name: /On-device/i }))
    expect(onCategoryChange).toHaveBeenCalledWith("local")
  })

  it("fires onSelect with the provider id on click", async () => {
    const user = userEvent.setup()
    const { onSelect } = setup()
    // Find the OcrSidebarItem button for ocrs.
    const ocrsBtn = screen.getByRole("button", { name: /ocrs \(local\)/i })
    await user.click(ocrsBtn)
    expect(onSelect).toHaveBeenCalledWith("ocrs")
  })

  it("fires onSelect with the auto-router id when its pinned item is clicked", async () => {
    const user = userEvent.setup()
    const { onSelect } = setup({ selectedId: "mistral-ocr" })
    await user.click(screen.getByTestId("ocr-auto-router-item"))
    expect(onSelect).toHaveBeenCalledWith(OCR_AUTO_ROUTER_ID)
  })

  it("renders Clear OCR cache and fires onClearCache", async () => {
    const user = userEvent.setup()
    const { onClearCache } = setup()
    await user.click(screen.getByRole("button", { name: /Clear OCR cache/i }))
    expect(onClearCache).toHaveBeenCalledTimes(1)
  })

  it("renders the stats row with the supplied counts", () => {
    setup({ stats: { enabled: 5, local: 3, cloud: 4 } })
    expect(screen.getByText(/5 enabled/)).toBeInTheDocument()
    expect(screen.getByText(/3 local/)).toBeInTheDocument()
    expect(screen.getByText(/4 cloud/)).toBeInTheDocument()
  })

  it("highlights the selected item via the bg-primary class", () => {
    setup({ selectedId: "ocrs" })
    const ocrsBtn = screen.getByRole("button", { name: /ocrs \(local\)/i })
    expect(ocrsBtn.className).toMatch(/bg-primary/)
  })

  it("marks Auto-Router as selected by default and exposes the badge", () => {
    setup()
    const auto = screen.getByTestId("ocr-auto-router-item")
    expect(auto.className).toMatch(/bg-primary/)
    expect(within(auto).getByText(/Default/i)).toBeInTheDocument()
  })
})
