/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

jest.mock("@/components/chat/renderers/image-block", () => ({
  ImageBlock: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="screenshot-image" src={src} alt={alt} />
  ),
}))

import { ScreenshotResultCard, screenshotBlocks } from "./screenshot-result-card"

const PNG = "iVBORw0KGgo="

describe("ScreenshotResultCard", () => {
  it("renders the image block from output.content with the text note as caption", () => {
    const part = {
      type: "tool-take_screenshot",
      state: "output-available",
      input: {},
      output: {
        content: [
          { type: "text", text: "screenshot.png (1234 bytes), copied to clipboard" },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      },
    } as unknown as ToolUIPart
    render(<ScreenshotResultCard part={part} />)
    expect(screen.getByTestId("screenshot-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`
    )
    expect(screen.getByTestId("screenshot-result-note")).toHaveTextContent(
      "screenshot.png (1234 bytes)"
    )
  })

  it("prefers mcpContent blocks and tolerates a JSON-string output", () => {
    const part = {
      type: "tool-take_screenshot",
      state: "output-available",
      input: {},
      output: JSON.stringify({ content: [{ type: "image", data: PNG, mimeType: "image/jpeg" }] }),
    } as unknown as ToolUIPart
    expect(screenshotBlocks(part)).toHaveLength(1)
    render(<ScreenshotResultCard part={part} />)
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `data:image/jpeg;base64,${PNG}`
    )
    const withMcp = { ...part, output: undefined, mcpContent: [{ type: "image", data: PNG }] }
    expect(screenshotBlocks(withMcp)).toHaveLength(1)
  })

  it("declines when there is no image block (host falls back)", () => {
    const part = {
      type: "tool-take_screenshot",
      state: "output-available",
      input: {},
      output: { ok: false, error: "capture-failed" },
    } as unknown as ToolUIPart
    const { container } = render(<ScreenshotResultCard part={part} />)
    expect(container).toBeEmptyDOMElement()
    expect(screenshotBlocks({ output: 42 })).toEqual([])
  })
})
