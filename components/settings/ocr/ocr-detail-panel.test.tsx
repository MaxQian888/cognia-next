import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrDetailPanel } from "./ocr-detail-panel"

function setup(overrides: Partial<React.ComponentProps<typeof OcrDetailPanel>> = {}) {
  const onToggleEnabled = jest.fn()
  const utils = render(
    <OcrDetailPanel
      provider={{ id: "mistral-ocr", name: "Mistral OCR", category: "document-cloud" }}
      status="connected"
      isEnabled
      onToggleEnabled={onToggleEnabled}
      configTab={<div data-testid="cfg-content">CONFIG</div>}
      modelsTab={<div data-testid="models-content">MODELS</div>}
      advancedTab={<div data-testid="adv-content">ADVANCED</div>}
      {...overrides}
    />
  )
  return { ...utils, onToggleEnabled }
}

describe("OcrDetailPanel", () => {
  it("renders the provider name and category subtitle", () => {
    setup()
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Mistral OCR")
    expect(screen.getByText(/Document OCR/i)).toBeInTheDocument()
  })

  it("renders the provider brand icon", () => {
    setup()

    expect(document.querySelector('img[src="/icons/lobe/mistral-color.svg"]')).not.toBeNull()
  })

  it("renders all three tabs", () => {
    setup()
    expect(screen.getByRole("tab", { name: /Config/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Models/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Advanced/i })).toBeInTheDocument()
  })

  it("defaults to the Config tab content", () => {
    setup()
    expect(screen.getByTestId("cfg-content")).toBeInTheDocument()
  })

  it("switches to Models content when its tab is clicked", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole("tab", { name: /Models/i }))
    expect(screen.getByTestId("models-content")).toBeInTheDocument()
  })

  it("switches to Advanced content when its tab is clicked", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole("tab", { name: /Advanced/i }))
    expect(screen.getByTestId("adv-content")).toBeInTheDocument()
  })

  it("propagates enable toggle clicks", async () => {
    const user = userEvent.setup()
    const { onToggleEnabled } = setup({ isEnabled: true })
    await user.click(screen.getByRole("switch"))
    expect(onToggleEnabled).toHaveBeenCalledWith(false)
  })

  it("renders the connected status badge variant", () => {
    setup({ status: "connected" })
    const badge = document.querySelector('[data-status="connected"]')
    expect(badge).not.toBeNull()
    expect(badge?.className).toMatch(/green/)
  })

  it("renders the error status badge variant", () => {
    setup({ status: "error" })
    const badge = document.querySelector('[data-status="error"]')
    expect(badge?.className).toMatch(/red/)
  })

  it("renders the not-configured status badge variant", () => {
    setup({ status: "not-configured" })
    const badge = document.querySelector('[data-status="not-configured"]')
    expect(badge).not.toBeNull()
  })

  it("renders the unsupported status badge variant", () => {
    setup({ status: "unsupported" })
    const badge = document.querySelector('[data-status="unsupported"]')
    expect(badge).not.toBeNull()
  })

  it("renders the ready status badge variant", () => {
    setup({ status: "ready" })
    const badge = document.querySelector('[data-status="ready"]')
    expect(badge?.className).toMatch(/green/)
  })
})
