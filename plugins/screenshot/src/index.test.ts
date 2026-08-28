/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
// Mocked at the SDK subpaths the plugin imports, not at the host modules
// behind them: a plugin's test should be able to run against the published
// surface alone, the same way a third-party plugin's would.
jest.mock("@cognia/plugin-sdk/api/automation", () => ({
  captureScreenshot: jest.fn(),
}))

jest.mock("@cognia/plugin-sdk/api/slash-command", () => ({
  registerSlashCommand: jest.fn(),
  unregisterSlashCommandsByPlugin: jest.fn(),
}))

const extractMock = jest.fn()
jest.mock("@cognia/plugin-sdk/api/ocr-provider", () => ({
  extract: (...a: unknown[]) => extractMock(...a),
  buildOcrDeps: () => ({}),
}))

import { captureScreenshot } from "@cognia/plugin-sdk/api/automation"
import {
  registerSlashCommand,
  unregisterSlashCommandsByPlugin as unregisterCommandsByPlugin,
} from "@cognia/plugin-sdk/api/slash-command"
import screenshotPlugin, { captureToToolResult } from "./index"

const captureMock = captureScreenshot as jest.Mock
const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

const makeCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-screenshot",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerTool: ({
        name,
        execute,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
      }) => {
        tools[name] = execute
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, tools }
}

beforeEach(() => {
  captureMock.mockReset()
  registerMock.mockReset()
  unregisterMock.mockReset()
})

describe("screenshot (built-in)", () => {
  it("registers take_screenshot and declares its command instead of registering it", async () => {
    const { ctx, tools } = makeCtx()
    const hooks = await screenshotPlugin.activate?.(ctx)
    expect(Object.keys(tools)).toContain("take_screenshot")
    // The slash command is DECLARED (manifest.commands[]) and handled via the
    // returned hook — the supported shape. The plugin must NOT touch the
    // slash registry itself: doing so skipped the manager's namespacing,
    // conflict detection, aliases, command-palette entry and teardown.
    expect(registerMock).not.toHaveBeenCalled()
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (screenshotPlugin.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["screenshot"])
  })

  it("registers the take_screenshot result card when the host offers the API (ADR-0127)", async () => {
    const { ctx } = makeCtx()
    const registerToolResultRenderer = jest.fn((_tool: string, _render: unknown) => () => {})
    ;(ctx as { toolResult?: unknown }).toolResult = { registerToolResultRenderer }
    await screenshotPlugin.activate?.(ctx)
    expect(registerToolResultRenderer).toHaveBeenCalledTimes(1)
    expect(registerToolResultRenderer.mock.calls[0][0]).toBe("take_screenshot")
    expect(typeof registerToolResultRenderer.mock.calls[0][1]).toBe("function")
  })

  it("handles its declared command and ignores everyone else's", async () => {
    const { ctx } = makeCtx()
    captureMock.mockResolvedValue(null)
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await screenshotPlugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("someone-elses-command", [])).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(await hooks?.onCommand?.("screenshot", [])).toBe(true)
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/failed/i), "error")
  })

  it("toasts the filename and size on a successful slash-command capture", async () => {
    // The slash command still consumes the raw capture shape (it needs the
    // filename/size for the toast), so the tool's content-block wrapper must
    // not have swallowed it.
    captureMock.mockResolvedValue({
      name: "screenshot.png",
      size: 9,
      type: "image/png",
      arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
    } as unknown as File)
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await screenshotPlugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("screenshot", [])).toBe(true)
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Captured screenshot.png (9 bytes)"),
      "success"
    )
  })

  it("surfaces a thrown capture as an error envelope, not a crash", async () => {
    captureMock.mockRejectedValue(new Error("display denied"))
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    expect(await tools.take_screenshot({})).toMatchObject({ ok: false, error: "display denied" })
    expect(await tools.extract_screenshot_ocr({})).toMatchObject({
      ok: false,
      error: "display denied",
    })
  })

  it("registers extract_screenshot_ocr and OCRs the captured image", async () => {
    extractMock.mockReset().mockResolvedValue({
      providerId: "tesseract-wasm",
      pages: [
        {
          pageNumber: 1,
          markdown: "**HI**",
          text: "HI",
          blocks: [{ text: "HI", bbox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9 }],
        },
      ],
      combinedMarkdown: "**HI**",
      combinedText: "HI",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    })
    const mockFile = {
      name: "screenshot.png",
      size: 9,
      type: "image/png",
      arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
    } as unknown as File
    captureMock.mockResolvedValue(mockFile)
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    expect(Object.keys(tools)).toContain("extract_screenshot_ocr")
    const result = (await tools.extract_screenshot_ocr({ languages: ["en"] })) as {
      ok: boolean
      text?: string
      blocks?: Array<{ text: string; bbox?: { x: number } }>
    }
    expect(result.ok).toBe(true)
    expect(result.text).toBe("HI")
    expect(result.blocks).toEqual([
      { text: "HI", bbox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9 },
    ])
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("extract_screenshot_ocr returns ok=false when capture is cancelled", async () => {
    captureMock.mockResolvedValue(null)
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.extract_screenshot_ocr({})) as { ok: boolean }
    expect(result.ok).toBe(false)
  })

  it("returns ok=false when capture is cancelled", async () => {
    captureMock.mockResolvedValue(null)
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = await tools.take_screenshot({})
    expect(result).toMatchObject({ ok: false, error: "user-cancelled-or-unsupported" })
  })

  it("returns an MCP image content block on a successful capture", async () => {
    // jsdom's File.arrayBuffer is unreliable; provide a custom mock object
    // that quacks like a File enough for the plugin's encoding helper.
    const mockFile = {
      name: "screenshot.png",
      size: 9,
      type: "image/png",
      arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
    } as unknown as File
    captureMock.mockResolvedValue(mockFile)
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    // Returning `{ ok, base64 }` here used to make the sidecar stringify the
    // PNG into one text block: the model got unreadable base64 and the chat
    // rendered a wall of it. The content-block form is what both dispatch
    // paths pass through so a vision model actually sees the screen.
    const result = (await tools.take_screenshot({})) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    }
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: "text" })
    expect(result.content[0].text).toContain("screenshot.png")
    expect(result.content[1].type).toBe("image")
    expect(result.content[1].mimeType).toBe("image/png")
    expect(result.content[1].data?.length).toBeGreaterThan(0)
  })

  it("notes the clipboard copy in the image caption when it succeeded", () => {
    expect(
      captureToToolResult({
        ok: true,
        base64: "AAAA",
        filename: "shot.png",
        size: 12,
        mimeType: "image/png",
        copiedToClipboard: true,
      })
    ).toEqual({
      content: [
        { type: "text", text: "shot.png (12 bytes), copied to clipboard" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    })
  })

  it("keeps the plain error envelope for a failed capture (no content blocks)", () => {
    // The passthrough only fires on a well-formed `content[]`, so an error
    // stays a JSON object the model can read plainly.
    expect(captureToToolResult({ ok: false, error: "user-cancelled" })).toEqual({
      ok: false,
      error: "user-cancelled",
    })
    expect(captureToToolResult({ ok: true })).toEqual({ ok: false, error: "capture-failed" })
  })

  it("declares lazy activation for its command", async () => {
    const events = (screenshotPlugin.manifest as { activationEvents?: string[] }).activationEvents
    expect(events).toContain("onCommand:screenshot")
  })

  it("has no imperative teardown left to do", async () => {
    const { ctx } = makeCtx()
    await screenshotPlugin.deactivate?.(ctx)
    // The manager unregisters manifest-declared commands itself.
    expect(unregisterMock).not.toHaveBeenCalled()
  })
})
