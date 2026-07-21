/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/ui/screenshot", () => ({
  captureScreenshot: jest.fn(),
}))

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

const extractMock = jest.fn()
jest.mock("@/lib/ocr", () => ({ extract: (...a: unknown[]) => extractMock(...a) }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({}) }))

import { captureScreenshot } from "@/lib/ui/screenshot"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import screenshotPlugin from "./index"

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
    expect(result).toMatchObject({ ok: false })
  })

  it("returns base64 payload on a successful capture", async () => {
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
    const result = (await tools.take_screenshot({})) as {
      ok: boolean
      filename: string
      base64: string
      error?: string
    }
    expect(result.ok).toBe(true)
    expect(result.filename).toBe("screenshot.png")
    expect(typeof result.base64).toBe("string")
    expect(result.base64.length).toBeGreaterThan(0)
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
