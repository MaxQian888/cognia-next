/** @jest-environment jsdom */

import type { OcrResult, PluginContext } from "@cognia/plugin-sdk"
import { OcrError } from "@cognia/plugin-sdk/api/ocr-provider"
import { ocrPluginDefinition, runOcrTool, TOOL_PARAMETERS, type OcrToolInput } from "./index"

const result: OcrResult = {
  providerId: "mock",
  pages: [{ pageNumber: 1, markdown: "Hello", text: "Hello", blocks: [] }],
  combinedMarkdown: "Hello",
  combinedText: "Hello",
  languages: ["en"],
  durationMs: 1,
  cached: false,
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    isReady: jest.fn(() => true),
    extract: jest.fn(async () => result),
    extractFile: jest.fn(async () => result),
    extractScreen: jest.fn(async () => result),
    runSlashCommand: jest.fn(async () => ({ system: "Hello", result })),
    ...overrides,
  }
}

describe("runOcrTool", () => {
  it("routes data URLs through ctx.ocr.extract with all overrides", async () => {
    const runtime = makeRuntime()
    const input: OcrToolInput = {
      source: { kind: "data_url", value: "data:image/png;base64,YWJj" },
      languages: ["en"],
      provider: "mock",
      format: "markdown",
      pageRange: "1",
    }
    await expect(runOcrTool(input, { runtime })).resolves.toEqual({
      ok: true,
      result,
      provenance: { kind: "ocr", providerId: "mock", sourceKind: "data_url" },
      security: { untrusted: true, pii: "unreviewed" },
      untrustedNotice: expect.stringMatching(/untrusted.*sensitive personal data/i),
    })
    expect(runtime.extract).toHaveBeenCalledWith({
      source: {
        kind: "data-url",
        dataUrl: "data:image/png;base64,YWJj",
        mimeType: "image/png",
      },
      languages: ["en"],
      providerId: "mock",
      format: "markdown",
      pageRange: "1",
    })
  })

  it("routes file paths and screen capture through their governed methods", async () => {
    const runtime = makeRuntime()
    await runOcrTool(
      { source: { kind: "file_path", value: "/tmp/a.png" }, provider: "auto" },
      { runtime }
    )
    expect(runtime.extractFile).toHaveBeenCalledWith("/tmp/a.png", {
      languages: undefined,
      format: undefined,
      pageRange: undefined,
      providerId: undefined,
    })

    await runOcrTool({ source: { kind: "screen" }, languages: ["zh"] }, { runtime })
    expect(runtime.extractScreen).toHaveBeenCalledWith({ languages: ["zh"] })
  })

  it("rejects missing, unknown, and unavailable sources", async () => {
    const runtime = makeRuntime()
    await expect(runOcrTool({ source: { kind: "data_url" } }, { runtime })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Unknown source kind/),
    })
    await expect(
      runOcrTool({ source: { kind: "magic", value: "x" } } as never, { runtime })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Unknown source kind/) })
    await expect(
      runOcrTool(
        { source: { kind: "data_url", value: "data:image/png;base64,AA==" } },
        { runtime: makeRuntime({ isReady: () => false }) }
      )
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not ready/i) })
  })

  it("preserves typed OCR error codes", async () => {
    const runtime = makeRuntime({
      extract: jest.fn(async () => {
        throw new OcrError("rate_limited", "mock", "slow")
      }),
    })
    await expect(
      runOcrTool({ source: { kind: "data_url", value: "data:image/png;base64,AA==" } }, { runtime })
    ).resolves.toEqual({ ok: false, error: "slow", code: "rate_limited" })
  })
})

describe("OCR plugin activation", () => {
  it("registers the tool and renderer against context-owned APIs", async () => {
    const registerTool = jest.fn()
    const registerPartRenderer = jest.fn(() => jest.fn())
    const runtime = makeRuntime()
    const ctx = {
      pluginId: "cognia-ocr",
      logger: { info: jest.fn() },
      agent: { registerTool },
      ocr: runtime,
      chat: { appendMessagePart: jest.fn() },
      messagePart: { registerPartRenderer },
      ui: { showToast: jest.fn() },
    } as unknown as PluginContext

    const hooks = await ocrPluginDefinition.activate?.(ctx)
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "ocr.extract" }))
    expect(registerPartRenderer).toHaveBeenCalledWith("ocr-result", expect.any(Function))

    const tool = registerTool.mock.calls[0]?.[0]
    await tool.execute({ source: { kind: "data_url", value: "data:image/png;base64,AA==" } })
    expect(runtime.extract).toHaveBeenCalledTimes(1)

    expect(await hooks?.onCommand?.("other", [])).toBe(false)
    expect(await hooks?.onCommand?.("ocr", ["/tmp/a.png"])).toBe(true)
    expect(runtime.runSlashCommand).toHaveBeenCalledWith("/tmp/a.png")
  })

  it("reports unavailable OCR without invoking the slash runtime", async () => {
    const runtime = makeRuntime({ isReady: () => false })
    const showToast = jest.fn()
    const ctx = {
      pluginId: "cognia-ocr",
      logger: { info: jest.fn() },
      agent: { registerTool: jest.fn() },
      ocr: runtime,
      chat: { appendMessagePart: jest.fn() },
      messagePart: { registerPartRenderer: jest.fn() },
      ui: { showToast },
    } as unknown as PluginContext
    const hooks = await ocrPluginDefinition.activate?.(ctx)
    expect(await hooks?.onCommand?.("ocr", [])).toBe(true)
    expect(showToast).toHaveBeenCalledWith("OCR runtime is not ready.", "error")
    expect(runtime.runSlashCommand).not.toHaveBeenCalled()
  })

  it("advertises only resolvable source kinds", () => {
    const kinds = (
      TOOL_PARAMETERS as unknown as {
        properties: { source: { properties: { kind: { enum: string[] } } } }
      }
    ).properties.source.properties.kind.enum
    expect(kinds).toEqual(["data_url", "file_path", "screen"])
  })
})
