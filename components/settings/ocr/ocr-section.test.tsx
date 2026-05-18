import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrSection } from "./ocr-section"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/lib/ocr/types"

function renderSection(overrides: Partial<UserOcrSettings> = {}) {
  const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, ...overrides }
  const onChange = jest.fn()
  const onClearCache = jest.fn()
  const onClearProviderCache = jest.fn()
  const utils = render(
    <OcrSection
      settings={settings}
      onChange={onChange}
      onClearCache={onClearCache}
      onClearProviderCache={onClearProviderCache}
    />
  )
  return { ...utils, onChange, onClearCache, onClearProviderCache }
}

describe("OcrSection", () => {
  it("renders the OCR settings heading and description", () => {
    renderSection()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/ocr/i)
    expect(screen.getByTestId("ocr-section")).toBeInTheDocument()
  })

  it("lists every provider grouped by category", () => {
    renderSection()
    // The sidebar list renders the translated label for every provider. The
    // default Jest i18n mock resolves keys against `en.json`, so each label
    // is the human-readable provider name (e.g. "Mistral OCR").
    const knownLabels = [
      /Mistral OCR/i,
      /Google Cloud Vision/i,
      /AWS Textract/i,
      /Azure AI Document Intelligence/i,
      /Claude \(vision\)/i,
      /OpenAI \(vision\)/i,
      /Gemini \(vision\)/i,
      /Mathpix/i,
      /OCR\.space/i,
      /ABBYY/i,
      /Nanonets/i,
      /Feishu \/ Lark/i,
      /Tesseract \(WASM\)/i,
      /Tesseract \(native\)/i,
      /Windows\.Media\.Ocr/i,
      /Apple Vision/i,
      /ML Kit Text Recognition/i,
    ]
    for (const label of knownLabels) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it("invokes onChange when the default languages input changes", async () => {
    const { onChange } = renderSection()
    const input = screen.getByLabelText(/languages/i) as HTMLInputElement
    // userEvent.type escapes commas; fire a change event directly so we keep
    // the assertion focused on the controlled-input wiring.
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "en,zh"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(last.defaultLanguages).toEqual(["en", "zh"])
  })

  it("toggles the cloud-fallback switch", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection({ cloudFallbackEnabled: true })
    const switches = screen.getAllByRole("switch")
    const cloudFallback = switches.find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("cloud")
    )!
    await user.click(cloudFallback)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(last.cloudFallbackEnabled).toBe(false)
  })

  it("toggles a provider's enabled flag from the detail card", async () => {
    const user = userEvent.setup()
    const { onChange } = renderSection()
    const detailCard = screen.getByTestId("ocr-provider-detail")
    const toggle = within(detailCard).getByRole("switch")
    await user.click(toggle)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]![0] as UserOcrSettings
    expect(Object.values(last.providerEnabled)).toContain(false)
  })

  it("calls onClearCache when the global clear-cache button is pressed", async () => {
    const user = userEvent.setup()
    const { onClearCache } = renderSection()
    await user.click(screen.getByRole("button", { name: "Clear OCR cache" }))
    expect(onClearCache).toHaveBeenCalledTimes(1)
  })

  it("calls onClearProviderCache scoped to the selected provider", async () => {
    const user = userEvent.setup()
    const { onClearProviderCache } = renderSection()
    const detailCard = screen.getByTestId("ocr-provider-detail")
    const button = within(detailCard).getByRole("button", {
      name: /clear cache for this provider/i,
    })
    await user.click(button)
    expect(onClearProviderCache).toHaveBeenCalledTimes(1)
    // Default selection is the first provider in PROVIDER_LIST.
    expect(onClearProviderCache).toHaveBeenCalledWith("mistral-ocr")
  })
})
