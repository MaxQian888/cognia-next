/**
 * @jest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual("@cognia/plugin-ui"),
  PluginImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="screenshot-image" src={src} alt={alt} />
  ),
}))

import manifestJson from "../plugin.json"
import {
  formatSize,
  parseScreenshotCaption,
  PLUGIN_ID,
  SCREENSHOT_PART_TYPE,
  ScreenshotMessagePart,
  ScreenshotResultCard,
  screenshotBlocks,
} from "./screenshot-result-card"

const PNG = "iVBORw0KGgo="

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

const caption = (copiedToClipboard: boolean) =>
  JSON.stringify({
    ok: true,
    filename: "screenshot.png",
    size: 1234,
    mimeType: "image/png",
    copiedToClipboard,
  })

describe("ScreenshotResultCard", () => {
  it("renders the image block and localizes the structured caption", () => {
    const part = {
      type: "tool-take_screenshot",
      state: "output-available",
      input: {},
      output: {
        content: [
          { type: "text", text: caption(true) },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      },
    } as unknown as ToolUIPart
    render(<ScreenshotResultCard part={part} />)
    expect(screen.getByTestId("screenshot-result-card")).toBeInTheDocument()
    expect(screen.getByText("Screenshot")).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`
    )
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute("alt", "Captured screen")
    expect(screen.getByTestId("screenshot-result-note")).toHaveTextContent(
      "screenshot.png (1.2 KB) Copied to clipboard."
    )
  })

  it("shows a legacy plain-text note verbatim", () => {
    const part = {
      type: "tool-take_screenshot",
      state: "output-available",
      input: {},
      output: {
        content: [
          { type: "text", text: "screenshot.png (1234 bytes)" },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      },
    } as unknown as ToolUIPart
    render(<ScreenshotResultCard part={part} />)
    expect(screen.getByTestId("screenshot-result-note")).toHaveTextContent(
      "screenshot.png (1234 bytes)"
    )
  })

  it("parses only well-formed captions and formats sizes", () => {
    expect(parseScreenshotCaption(caption(false))).toMatchObject({
      filename: "screenshot.png",
      size: 1234,
      copiedToClipboard: false,
    })
    expect(parseScreenshotCaption("not json")).toBeNull()
    expect(parseScreenshotCaption(JSON.stringify({ filename: 1 }))).toBeNull()
    expect(formatSize(512)).toBe("512 B")
    expect(formatSize(2048)).toBe("2.0 KB")
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
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

  it("renders the appended screenshot-result message part through the same card", () => {
    // The `/screenshot` command appends `{ type: "screenshot-result",
    // mcpContent: [...] }` via ctx.chat.appendMessagePart — the registered
    // message-part renderer draws it with the tool card unchanged.
    const part = {
      type: SCREENSHOT_PART_TYPE,
      mcpContent: [
        { type: "text", text: caption(false) },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    }
    render(<ScreenshotMessagePart part={part as never} />)
    expect(screen.getByTestId("screenshot-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("screenshot-result-note")).toHaveTextContent(
      "screenshot.png (1.2 KB)"
    )
    expect(screen.getByTestId("screenshot-result-note")).not.toHaveTextContent("Copied")
    expect(screen.getByTestId("screenshot-image")).toHaveAttribute(
      "src",
      `data:image/png;base64,${PNG}`
    )
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
