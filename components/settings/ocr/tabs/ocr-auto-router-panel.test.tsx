import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { OcrAutoRouterPanel, type AutoRouterProviderOption } from "./ocr-auto-router-panel"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/lib/ocr/types"

const PROVIDERS: AutoRouterProviderOption[] = [
  { id: "mistral-ocr", label: "Mistral OCR", isCloudOrVision: true },
  { id: "google-vision", label: "Google Cloud Vision", isCloudOrVision: true },
  { id: "tesseract-wasm", label: "Tesseract (WASM)", isCloudOrVision: false },
]

function setup(overrides: Partial<UserOcrSettings> = {}) {
  const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, ...overrides }
  const onChange = jest.fn()
  const onClearCache = jest.fn()
  const utils = render(
    <OcrAutoRouterPanel
      settings={settings}
      onChange={onChange}
      providers={PROVIDERS}
      onClearCache={onClearCache}
    />
  )
  return { ...utils, onChange, onClearCache }
}

describe("OcrAutoRouterPanel", () => {
  it("renders all default fields", () => {
    setup()
    expect(screen.getByLabelText(/Default provider/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Default output format/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Default languages/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Max image dimension/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Cloud fallback provider/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Cache TTL/i)).toBeInTheDocument()
  })

  it("updates defaultProviderId when the dropdown changes", async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByLabelText(/Default provider/i))
    await user.click(await screen.findByRole("option", { name: /Mistral OCR/i }))
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.defaultProviderId).toBe("mistral-ocr")
  })

  it("updates defaultFormat", async () => {
    const user = userEvent.setup()
    const { onChange } = setup()
    await user.click(screen.getByLabelText(/Default output format/i))
    await user.click(await screen.findByRole("option", { name: /Plain text/i }))
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.defaultFormat).toBe("text")
  })

  it("updates defaultLanguages from a comma-separated input", async () => {
    const { onChange } = setup()
    const input = screen.getByLabelText(/Default languages/i) as HTMLInputElement
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "en,zh"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.defaultLanguages).toEqual(["en", "zh"])
  })

  it("updates maxImageDimension", async () => {
    const { onChange } = setup()
    const input = screen.getByLabelText(/Max image dimension/i) as HTMLInputElement
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "3072"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.maxImageDimension).toBe(3072)
  })

  it("toggles cloudFallbackEnabled", async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ cloudFallbackEnabled: true })
    const switches = screen.getAllByRole("switch")
    const cloud = switches.find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("cloud")
    )!
    await user.click(cloud)
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.cloudFallbackEnabled).toBe(false)
  })

  it("disables the cloud fallback provider Select when cloudFallbackEnabled is false", () => {
    setup({ cloudFallbackEnabled: false })
    expect(screen.getByLabelText(/Cloud fallback provider/i)).toBeDisabled()
  })

  it("toggles pdfTextLayerFastPath", async () => {
    const user = userEvent.setup()
    const { onChange } = setup({ pdfTextLayerFastPath: true })
    const switches = screen.getAllByRole("switch")
    const fastPath = switches.find((el) =>
      el.getAttribute("aria-label")?.toLowerCase().includes("pdf")
    )!
    await user.click(fastPath)
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.pdfTextLayerFastPath).toBe(false)
  })

  it("updates cacheTtlDays", async () => {
    const { onChange } = setup()
    const input = screen.getByLabelText(/Cache TTL/i) as HTMLInputElement
    input.focus()
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "0"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const last = onChange.mock.calls.at(-1)![0] as UserOcrSettings
    expect(last.cacheTtlDays).toBe(0)
  })

  it("fires onClearCache when the clear-all button is clicked", async () => {
    const user = userEvent.setup()
    const { onClearCache } = setup()
    await user.click(screen.getByTestId("ocr-clear-all-cache"))
    expect(onClearCache).toHaveBeenCalledTimes(1)
  })
})
