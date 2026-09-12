/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const copy = jest.fn()
jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual("@cognia/plugin-ui"),
  PluginImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="screenshot-ocr-image" src={src} alt={alt} />
  ),
  useCopy: () => ({ copied: false, copy }),
}))

import { ScreenshotOcrResultCard } from "./screenshot-ocr-result-card"

function part(output: unknown): ToolUIPart {
  return {
    type: "tool-extract_screenshot_ocr",
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

const SUCCESS = {
  ok: true,
  text: "hello world",
  markdown: "hello world",
  providerId: "tesseract-wasm",
  blocks: [],
}

describe("ScreenshotOcrResultCard", () => {
  it("renders the recognized text, provider badge, and actions", () => {
    render(<ScreenshotOcrResultCard part={part(SUCCESS)} />)
    expect(screen.getByTestId("screenshot-ocr-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-ocr-text").textContent).toBe("hello world")
    expect(screen.getByText(/Provider: tesseract-wasm/)).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-ocr-copy")).toBeEnabled()
    expect(screen.getByTestId("screenshot-ocr-ask")).toBeEnabled()
  })

  it("parses a JSON-string output (the serialized wire shape)", () => {
    render(<ScreenshotOcrResultCard part={part(JSON.stringify(SUCCESS))} />)
    expect(screen.getByTestId("screenshot-ocr-text").textContent).toBe("hello world")
  })

  it("renders the includeImage shape: thumbnail + envelope from the text block", () => {
    const output = {
      content: [
        { type: "text", text: JSON.stringify({ ...SUCCESS, image: undefined }) },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    }
    render(<ScreenshotOcrResultCard part={part(output)} />)
    expect(screen.getByTestId("screenshot-ocr-image")).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo="
    )
    expect(screen.getByTestId("screenshot-ocr-text").textContent).toBe("hello world")
  })

  it("declines a content-block output whose text block is not the envelope", () => {
    const output = {
      content: [
        { type: "text", text: "plain prose, not json" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    }
    const { container } = render(<ScreenshotOcrResultCard part={part(output)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("copies the recognized text", () => {
    render(<ScreenshotOcrResultCard part={part(SUCCESS)} />)
    fireEvent.click(screen.getByTestId("screenshot-ocr-copy"))
    expect(copy).toHaveBeenCalledWith("hello world")
  })

  it("dispatches the composer-append event on 'ask about this'", () => {
    const handler = jest.fn()
    window.addEventListener("cognia:composer-append", handler)
    render(<ScreenshotOcrResultCard part={part(SUCCESS)} />)
    fireEvent.click(screen.getByTestId("screenshot-ocr-ask"))
    expect(handler).toHaveBeenCalledTimes(1)
    const evt = handler.mock.calls[0][0] as CustomEvent
    expect(evt.detail.text).toBe("hello world")
    window.removeEventListener("cognia:composer-append", handler)
  })

  it("shows the empty state and disables the actions when nothing was recognized", () => {
    render(<ScreenshotOcrResultCard part={part({ ...SUCCESS, text: "   " })} />)
    expect(screen.getByText("No text recognized.")).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-ocr-copy")).toBeDisabled()
    expect(screen.getByTestId("screenshot-ocr-ask")).toBeDisabled()
  })

  it("declines error envelopes and junk output (host falls back)", () => {
    for (const output of [{ ok: false, error: "display denied" }, "not json", 42, { ok: true }]) {
      const { container } = render(<ScreenshotOcrResultCard part={part(output)} />)
      expect(container).toBeEmptyDOMElement()
    }
  })
})
