/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { OcrResultCard } from "./ocr-result-card"
import type { OcrResultPart } from "@cognia/plugin-sdk/api/ocr-provider"
// The renderer prop is typed as the SDK UIMessage part union; our custom part
// isn't in it, so cast the component to accept the OcrResultPart fixture.
const Card = OcrResultCard as unknown as (p: {
  part: OcrResultPart
}) => ReturnType<typeof OcrResultCard>

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const copy = jest.fn()
jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual("@cognia/plugin-ui"),
  PluginImage: ({ src }: { src: string }) => <img data-testid="ocr-thumb" src={src} alt="" />,
  useCopy: () => ({ copied: false, copy }),
}))
jest.mock("@cognia/plugin-sdk/api/host-environment", () => ({
  readHostCapabilities: () => ({ tauri: false, platform: "web" }),
}))

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
    ...over,
  }
}

describe("OcrResultCard", () => {
  it("renders selectable text + provider/language/confidence/duration badges", () => {
    render(<Card part={part()} />)
    expect(screen.getByTestId("ocr-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-result-text").textContent).toBe("hello world")
    expect(screen.getByText(/provider.*tesseract/)).toBeInTheDocument()
    expect(screen.getByText(/languages.*en, zh/)).toBeInTheDocument()
    expect(screen.getByText(/confidence.*"pct":82/)).toBeInTheDocument()
    expect(screen.getByText(/duration.*120/)).toBeInTheDocument()
  })

  it("omits the confidence badge when confidence is null", () => {
    render(<Card part={part({ confidence: null })} />)
    expect(screen.queryByText(/confidence/)).toBeNull()
  })

  it("shows a data-url thumbnail directly", () => {
    render(
      <Card part={part({ sourceRef: { kind: "data-url", value: "data:image/png;base64,AAA" } })} />
    )
    expect(screen.getByTestId("ocr-thumb").getAttribute("src")).toBe("data:image/png;base64,AAA")
  })

  it("renders no thumbnail for an attachment-id source (best-effort)", () => {
    render(<Card part={part({ sourceRef: { kind: "attachment-id", value: "att_1" } })} />)
    expect(screen.queryByTestId("ocr-thumb")).toBeNull()
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

  it("shows the empty state and disables ask when there is no text", () => {
    render(<Card part={part({ text: "   " })} />)
    expect(screen.getByText("noText")).toBeInTheDocument()
    expect(screen.getByTestId("ocr-result-ask")).toBeDisabled()
  })

  it("returns null for a non-ocr part", () => {
    const { container } = render(<Card part={{ type: "text", text: "x" } as never} />)
    expect(container.firstChild).toBeNull()
  })
})
