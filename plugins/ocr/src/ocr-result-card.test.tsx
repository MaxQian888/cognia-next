/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import manifestJson from "../plugin.json"
import { OcrResultCard, PLUGIN_ID, thumbnailSrc } from "./ocr-result-card"
import type { OcrResultPart } from "@cognia/plugin-sdk/api/ocr-provider"
// The renderer prop is typed as the SDK UIMessage part union; our custom part
// isn't in it, so cast the component to accept the OcrResultPart fixture.
const Card = OcrResultCard as unknown as (p: {
  part: OcrResultPart
}) => ReturnType<typeof OcrResultCard>

const copy = jest.fn()
jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual("@cognia/plugin-ui"),
  PluginImage: ({ src }: { src: string }) => <img data-testid="ocr-thumb" src={src} alt="" />,
  useCopy: () => ({ copied: false, copy }),
}))

/** Register the plugin's own bundle the way the manager does on enable. */
function registerBundle() {
  const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(locales).map(([locale, dict]) => [
        locale,
        Object.fromEntries(
          Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
        ),
      ])
    ),
  })
}

beforeEach(() => registerBundle())
afterEach(() => {
  // Unmount first: unregistering re-renders every mounted consumer.
  cleanup()
  unregisterPluginI18n(PLUGIN_ID)
})

function part(over: Partial<OcrResultPart> = {}): OcrResultPart {
  return {
    type: "ocr-result",
    providerId: "tesseract",
    languages: ["en", "zh"],
    text: "hello world",
    markdown: "hello world",
    durationMs: 120,
    cached: false,
    confidence: 0.82,
    provenance: { kind: "ocr", providerId: "tesseract", sourceKind: "file_path" },
    security: { untrusted: true, pii: "unreviewed" },
    untrustedNotice: "Untrusted OCR text",
    ...over,
  }
}

describe("OcrResultCard", () => {
  it("renders selectable text + provider/language/confidence/duration badges", () => {
    render(<Card part={part()} />)
    expect(screen.getByTestId("ocr-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-result-text").textContent).toBe("hello world")
    expect(screen.getByText("Text recognized")).toBeInTheDocument()
    expect(screen.getByText("Provider: tesseract")).toBeInTheDocument()
    expect(screen.getByText("Languages: en, zh")).toBeInTheDocument()
    expect(screen.getByText("Confidence: 82%")).toBeInTheDocument()
    expect(screen.getByText("120 ms")).toBeInTheDocument()
    // ≥ 36px touch targets on small (touch) screens.
    expect(screen.getByTestId("ocr-result-copy").className).toContain("h-9")
    expect(screen.getByTestId("ocr-result-ask").className).toContain("h-9")
  })

  it("omits the confidence badge when confidence is null", () => {
    render(<Card part={part({ confidence: null })} />)
    expect(screen.queryByText(/Confidence/)).toBeNull()
  })

  it("shows a data-url thumbnail directly", () => {
    render(
      <Card part={part({ sourceRef: { kind: "data-url", value: "data:image/png;base64,AAA" } })} />
    )
    expect(screen.getByTestId("ocr-thumb").getAttribute("src")).toBe("data:image/png;base64,AAA")
  })

  it("renders no thumbnail for attachment-id or file-path sources", () => {
    render(<Card part={part({ sourceRef: { kind: "attachment-id", value: "att_1" } })} />)
    expect(screen.queryByTestId("ocr-thumb")).toBeNull()
    render(<Card part={part({ sourceRef: { kind: "file-path", value: "/tmp/a.png" } })} />)
    expect(screen.queryByTestId("ocr-thumb")).toBeNull()
  })

  it("only treats image data URLs as thumbnails", () => {
    expect(thumbnailSrc({ kind: "data-url", value: "data:image/png;base64,AAA" })).toBe(
      "data:image/png;base64,AAA"
    )
    expect(thumbnailSrc({ kind: "data-url", value: "data:application/pdf;base64,AAA" })).toBeNull()
    expect(thumbnailSrc(undefined)).toBeNull()
  })

  it("copies the recognized text", () => {
    render(<Card part={part()} />)
    fireEvent.click(screen.getByTestId("ocr-result-copy"))
    expect(copy).toHaveBeenCalledWith("hello world")
  })

  it("dispatches the composer-append event on 'ask about this'", () => {
    const handler = jest.fn()
    window.addEventListener("cognia:composer-append", handler)
    render(<Card part={part()} />)
    fireEvent.click(screen.getByTestId("ocr-result-ask"))
    expect(handler).toHaveBeenCalledTimes(1)
    const evt = handler.mock.calls[0][0] as CustomEvent
    expect(evt.detail.text).toBe("hello world")
    window.removeEventListener("cognia:composer-append", handler)
  })

  it("shows the empty state and disables the actions when there is no text", () => {
    render(<Card part={part({ text: "   " })} />)
    expect(screen.getByText("No text recognized.")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-result-ask")).toBeDisabled()
    expect(screen.getByTestId("ocr-result-copy")).toBeDisabled()
  })

  it("returns null for a non-ocr part", () => {
    const { container } = render(<Card part={{ type: "text", text: "x" } as never} />)
    expect(container.firstChild).toBeNull()
  })
})
