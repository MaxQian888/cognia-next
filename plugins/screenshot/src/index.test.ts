/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"

const extractMock = jest.fn()
const captureMock = jest.fn()
const screenshotMock = jest.fn()
const capabilitiesMock = jest.fn()
const writeImageMock = jest.fn()
const appendPartMock = jest.fn()
const registerPartRendererMock = jest.fn()

import manifestJson from "../plugin.json"
import screenshotPlugin, { CAPTURE_TOOL_TIMEOUT_MS, captureToToolResult } from "./index"
import { SCREENSHOT_PART_TYPE } from "./screenshot-result-card"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

/**
 * `ctx.i18n.t` stand-in that resolves the plugin's own manifest bundle (en)
 * with `{param}` interpolation — the same lookup the manager wires up — so
 * tests assert on the real shipped copy.
 */
const makeI18n = () => ({
  t: jest.fn((key: string, params?: Record<string, string | number | boolean>) => {
    const raw = LOCALES.en[key] ?? key
    return raw.replace(/\{(\w+)\}/g, (m, p) =>
      params && params[p] !== undefined ? String(params[p]) : m
    )
  }),
  getCurrentLocale: jest.fn(() => "en"),
})

type ToolDefinition = { timeoutMs?: number; requiresApproval?: boolean }

const makeCtx = () => {
  const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {}
  const definitions: Record<string, ToolDefinition> = {}
  const i18n = makeI18n()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-screenshot",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    ui: { showToast: jest.fn() } as never,
    toolResult: { registerToolResultRenderer: jest.fn(() => () => {}) } as never,
    agent: {
      registerTool: ({
        name,
        definition,
        execute,
      }: {
        name: string
        definition: ToolDefinition
        execute: (args: Record<string, unknown>) => Promise<unknown>
      }) => {
        tools[name] = execute
        definitions[name] = definition
      },
    } as never,
    ocr: { extract: extractMock } as never,
    automation: {
      captureDisplay: captureMock,
      screenshot: screenshotMock,
      capabilities: capabilitiesMock,
    } as never,
    clipboard: { writeImage: writeImageMock } as never,
    chat: { appendMessagePart: appendPartMock } as never,
    i18n: i18n as never,
    messagePart: { registerPartRenderer: registerPartRendererMock } as never,
  }
  return { ctx: ctx as PluginContext, tools, definitions, i18n }
}

const mockFile = {
  name: "screenshot.png",
  size: 9,
  type: "image/png",
  arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer,
} as unknown as File

beforeEach(() => {
  for (const mock of [
    captureMock,
    extractMock,
    screenshotMock,
    capabilitiesMock,
    writeImageMock,
    appendPartMock,
    registerPartRendererMock,
  ]) {
    mock.mockReset()
  }
  capabilitiesMock.mockResolvedValue({
    platform: "macos",
    hasScreenshot: true,
    monitors: [
      {
        id: "m1",
        name: "Built-in",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        isPrimary: true,
        scaleFactor: 2,
      },
      {
        id: "m2",
        name: "External",
        x: 1,
        y: 0,
        width: 1,
        height: 1,
        isPrimary: false,
        scaleFactor: 1,
      },
    ],
  })
  writeImageMock.mockResolvedValue(undefined)
  appendPartMock.mockReturnValue("plugin-cognia-screenshot-1")
  registerPartRendererMock.mockReturnValue(() => {})
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
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (screenshotPlugin.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["screenshot"])
  })

  it("declares the permissions its ctx calls actually need — no more, no less", async () => {
    const permissions = (screenshotPlugin.manifest as { permissions?: string[] }).permissions
    // ctx.automation.captureDisplay + ctx.automation.screenshot.
    expect(permissions).toContain("automation:screenshot")
    // ctx.automation.capabilities (list_screenshot_monitors).
    expect(permissions).toContain("automation:read")
    // ctx.clipboard.writeImage.
    expect(permissions).toContain("clipboard:write")
    // ctx.ocr.extract.
    expect(permissions).toContain("media:image:read")
    expect(permissions).toContain("database:write")
    // ctx.chat.appendMessagePart.
    expect(permissions).toContain("session:write")
    // ctx.toolResult.registerToolResultRenderer + ctx.messagePart.registerPartRenderer.
    expect(permissions).toContain("extension:ui")
    // Nothing the plugin calls consumes it — keep the declared surface honest.
    expect(permissions).not.toContain("media:image:write")
  })

  it("registers result cards for both tools when the host offers the API (ADR-0127)", async () => {
    const { ctx } = makeCtx()
    const registerToolResultRenderer = jest.fn((_tool: string, _render: unknown) => () => {})
    ;(ctx as { toolResult?: unknown }).toolResult = { registerToolResultRenderer }
    await screenshotPlugin.activate?.(ctx)
    expect(registerToolResultRenderer).toHaveBeenCalledTimes(2)
    expect(registerToolResultRenderer.mock.calls.map((c) => c[0])).toEqual([
      "take_screenshot",
      "extract_screenshot_ocr",
    ])
    for (const call of registerToolResultRenderer.mock.calls) {
      expect(typeof call[1]).toBe("function")
    }
  })

  it("registers a message-part renderer for the /screenshot transcript part", async () => {
    const { ctx } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    expect(registerPartRendererMock).toHaveBeenCalledTimes(1)
    expect(registerPartRendererMock.mock.calls[0][0]).toBe(SCREENSHOT_PART_TYPE)
    expect(typeof registerPartRendererMock.mock.calls[0][1]).toBe("function")
  })

  it("ships its strings in plugin.json's i18n bundle with matching en + zh-CN keys", () => {
    const manifest = screenshotPlugin.manifest as { i18n?: { locales?: Record<string, object> } }
    expect(manifest.i18n?.locales).toBe(manifestJson.i18n.locales)
    expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
    for (const key of ["toast.captured", "toast.failed", "card.title", "ocr.title"]) {
      expect(LOCALES.en[key]).toEqual(expect.any(String))
    }
  })

  it("gives the picker-blocking capture tools a long budget", async () => {
    const { ctx, definitions } = makeCtx()
    await screenshotPlugin.activate(ctx)
    expect(CAPTURE_TOOL_TIMEOUT_MS).toBe(120_000)
    expect(definitions.take_screenshot.timeoutMs).toBe(CAPTURE_TOOL_TIMEOUT_MS)
    expect(definitions.extract_screenshot_ocr.timeoutMs).toBe(CAPTURE_TOOL_TIMEOUT_MS)
    // The monitor listing is a quick read — default budget.
    expect(definitions.list_screenshot_monitors.timeoutMs).toBeUndefined()
  })

  it("handles its declared command and ignores everyone else's", async () => {
    const { ctx } = makeCtx()
    captureMock.mockResolvedValue(null)
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await screenshotPlugin.activate?.(ctx)
    expect(await hooks?.onCommand?.("someone-elses-command", [])).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(await hooks?.onCommand?.("screenshot", [])).toMatchObject({ handled: true })
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/failed/i), "error")
  })

  it("toasts the capture, copies via the host clipboard API, and drops the image into chat", async () => {
    captureMock.mockResolvedValue(mockFile)
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await screenshotPlugin.activate?.(ctx)
    const outcome = await hooks?.onCommand?.("screenshot", [])
    // The host clipboard bridge is the permissioned path — the WebView
    // navigator.clipboard.write is only the browser-shell fallback.
    expect(writeImageMock).toHaveBeenCalledTimes(1)
    expect(writeImageMock.mock.calls[0][0]).toBeInstanceOf(Uint8Array)
    expect(writeImageMock.mock.calls[0][1]).toBe("png")
    expect(outcome).toMatchObject({
      handled: true,
      message: expect.stringContaining("Captured screenshot.png (9 B)"),
    })
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Copied to clipboard."),
      "success"
    )
    // The capture lands in the transcript as a part the registered renderer draws.
    expect(appendPartMock).toHaveBeenCalledTimes(1)
    const part = appendPartMock.mock.calls[0][0] as {
      type: string
      mcpContent: Array<{ type: string; data?: string; text?: string }>
    }
    expect(part.type).toBe(SCREENSHOT_PART_TYPE)
    // Text block first — the structured caption the card localizes — then the image.
    expect(part.mcpContent[0].type).toBe("text")
    expect(JSON.parse(part.mcpContent[0].text ?? "{}")).toMatchObject({
      filename: "screenshot.png",
      size: 9,
      copiedToClipboard: true,
    })
    expect(part.mcpContent[1].type).toBe("image")
    expect(part.mcpContent[1].data?.length).toBeGreaterThan(0)
  })

  it("targets the session the command was typed in, not the ambient one", async () => {
    captureMock.mockResolvedValue(mockFile)
    const { ctx } = makeCtx()
    const hooks = await screenshotPlugin.activate?.(ctx)
    await hooks?.onCommand?.("screenshot", [], { sessionId: "session-42" })
    expect(appendPartMock).toHaveBeenCalledWith(expect.anything(), { sessionId: "session-42" })
  })

  it("/screenshot native skips the picker and captures through the automation path", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    const { ctx } = makeCtx()
    const hooks = await screenshotPlugin.activate?.(ctx)
    const outcome = await hooks?.onCommand?.("screenshot", ["native"])
    expect(screenshotMock).toHaveBeenCalledTimes(1)
    expect(captureMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ handled: true })
    expect(appendPartMock).toHaveBeenCalledTimes(1)
  })

  it("notes it in the command response when there is no session to attach to", async () => {
    captureMock.mockResolvedValue(mockFile)
    appendPartMock.mockReturnValue(null)
    const { ctx } = makeCtx()
    const warn = ctx.logger?.warn as jest.Mock
    const hooks = await screenshotPlugin.activate?.(ctx)
    const outcome = (await hooks?.onCommand?.("screenshot", [])) as { message?: string }
    // Still a successful capture + clipboard copy — only the attach failed.
    expect(outcome.message).toContain("Captured screenshot.png")
    expect(outcome.message).toContain("could not be attached")
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no chat session/i))
  })

  it("still answers the command when the clipboard write is unavailable", async () => {
    captureMock.mockResolvedValue(mockFile)
    writeImageMock.mockRejectedValue(new Error("NOT_SUPPORTED"))
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await screenshotPlugin.activate?.(ctx)
    const outcome = (await hooks?.onCommand?.("screenshot", [])) as { message?: string }
    expect(outcome.message).toContain("Captured screenshot.png")
    expect(outcome.message).not.toContain("Copied to clipboard")
    expect(appendPartMock).toHaveBeenCalledTimes(1)
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

  it("native mode captures through automation.screenshot without a picker", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD", // "ABC"
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.take_screenshot({ mode: "native" })) as {
      content: Array<{ type: string; data?: string; text?: string }>
    }
    expect(screenshotMock).toHaveBeenCalledTimes(1)
    expect(captureMock).not.toHaveBeenCalled()
    expect(result.content[1]).toMatchObject({ type: "image", data: "QUJD", mimeType: "image/png" })
    // Agent calls don't touch the clipboard unless they ask: a capture the
    // model takes for itself must not overwrite what the user copied.
    expect(writeImageMock).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0].text ?? "{}")).toMatchObject({ copiedToClipboard: false })
  })

  it("copies to the clipboard only when the tool call asks for it", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.take_screenshot({
      mode: "native",
      copyToClipboard: true,
    })) as { content: Array<{ type: string; text?: string }> }
    expect(writeImageMock).toHaveBeenCalledWith(Uint8Array.from([65, 66, 67]), "png")
    expect(JSON.parse(result.content[0].text ?? "{}")).toMatchObject({ copiedToClipboard: true })
  })

  it("forwards monitorId/region/format to automation.screenshot in native mode", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "jpeg",
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.take_screenshot({
      mode: "native",
      monitorId: "monitor-2",
      region: { x: 1, y: 2, width: 3, height: 4 },
      format: "jpeg",
    })) as { content: Array<{ type: string; mimeType?: string }> }
    expect(screenshotMock).toHaveBeenCalledWith({
      monitorId: "monitor-2",
      region: { x: 1, y: 2, width: 3, height: 4 },
      format: "jpeg",
    })
    expect(result.content[1].mimeType).toBe("image/jpeg")
  })

  it("drops malformed native options instead of forwarding them", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    await tools.take_screenshot({
      mode: "native",
      monitorId: 42,
      region: { x: 1 },
      format: "bmp",
    })
    expect(screenshotMock).toHaveBeenCalledWith(undefined)
    // The same knobs ride the OCR tool too.
    extractMock.mockResolvedValue({
      providerId: "tesseract-wasm",
      pages: [{ pageNumber: 1, markdown: "HI", text: "HI", blocks: [] }],
      combinedMarkdown: "HI",
      combinedText: "HI",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    })
    await tools.extract_screenshot_ocr({ mode: "native", monitorId: "monitor-1" })
    expect(screenshotMock).toHaveBeenLastCalledWith({ monitorId: "monitor-1" })
  })

  it("list_screenshot_monitors reports the native backend's monitors", async () => {
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.list_screenshot_monitors({})) as {
      ok: boolean
      nativeCapture?: boolean
      monitors?: Array<{ id: string; isPrimary: boolean }>
    }
    expect(result).toMatchObject({ ok: true, nativeCapture: true })
    expect(result.monitors).toHaveLength(2)
    expect(result.monitors?.[1]).toMatchObject({ id: "m2", isPrimary: false })
  })

  it("list_screenshot_monitors degrades to an error envelope on unsupported shells", async () => {
    capabilitiesMock.mockRejectedValue(new Error("NOT_SUPPORTED"))
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    expect(await tools.list_screenshot_monitors({})).toEqual({
      ok: false,
      error: "NOT_SUPPORTED",
    })
  })

  it("extract_screenshot_ocr emits the frame as an image block when includeImage is set", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    extractMock.mockResolvedValue({
      providerId: "tesseract-wasm",
      pages: [{ pageNumber: 1, markdown: "HI", text: "HI", blocks: [] }],
      combinedMarkdown: "HI",
      combinedText: "HI",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.extract_screenshot_ocr({
      mode: "native",
      includeImage: true,
    })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
    expect(result.content).toHaveLength(2)
    // The text block carries the full JSON envelope — same fields as the
    // plain-object shape, minus the in-memory `image` handle.
    const envelope = JSON.parse(result.content[0].text ?? "{}") as {
      ok: boolean
      text?: string
      image?: unknown
    }
    expect(envelope).toMatchObject({ ok: true, text: "HI" })
    expect(envelope.image).toBeUndefined()
    expect(result.content[1]).toMatchObject({
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    })
  })

  it("native mode feeds the OCR path too", async () => {
    screenshotMock.mockResolvedValue({
      bytes: "QUJD",
      width: 2,
      height: 2,
      capturedAt: 0,
      format: "png",
    })
    extractMock.mockResolvedValue({
      providerId: "tesseract-wasm",
      pages: [{ pageNumber: 1, markdown: "HI", text: "HI", blocks: [] }],
      combinedMarkdown: "HI",
      combinedText: "HI",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    })
    const { ctx, tools } = makeCtx()
    await screenshotPlugin.activate?.(ctx)
    const result = (await tools.extract_screenshot_ocr({ mode: "native" })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(screenshotMock).toHaveBeenCalledTimes(1)
    expect(captureMock).not.toHaveBeenCalled()
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "data-url",
          dataUrl: "data:image/png;base64,QUJD",
        }),
      })
    )
  })

  it("registers extract_screenshot_ocr and OCRs the captured image", async () => {
    extractMock.mockResolvedValue({
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
    expect(result).toMatchObject({
      provenance: { kind: "ocr", providerId: "tesseract-wasm", sourceKind: "screen" },
      security: { untrusted: true, pii: "unreviewed" },
      untrustedNotice: expect.stringMatching(/untrusted/i),
    })
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

  it("carries a structured caption (incl. the clipboard copy) ahead of the image", () => {
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
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            filename: "shot.png",
            size: 12,
            mimeType: "image/png",
            copiedToClipboard: true,
          }),
        },
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
    expect(screenshotPlugin.deactivate).toBeUndefined()
  })
})
