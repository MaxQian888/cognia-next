/** @jest-environment jsdom */

import type { OcrResult, PluginContext } from "@cognia/plugin-sdk"
import { OcrError } from "@cognia/plugin-sdk/api/ocr-provider"
import manifestJson from "../plugin.json"
import {
  OCR_TOOL_TIMEOUT_MS,
  ocrPluginDefinition,
  runOcrTool,
  TOOL_PARAMETERS,
  type OcrToolInput,
} from "./index"

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

  it("routes the top-level path and screen capture through their governed methods", async () => {
    const runtime = makeRuntime()
    await expect(
      runOcrTool({ path: "docs/a.png", provider: "auto" }, { runtime })
    ).resolves.toMatchObject({
      ok: true,
      provenance: { sourceKind: "file_path" },
    })
    expect(runtime.extractFile).toHaveBeenCalledWith("docs/a.png", {
      languages: undefined,
      format: undefined,
      pageRange: undefined,
      providerId: undefined,
    })

    await runOcrTool({ source: { kind: "screen" }, languages: ["zh"] }, { runtime })
    expect(runtime.extractScreen).toHaveBeenCalledWith({ languages: ["zh"] })
  })

  it("never reads a file from the nested source field (invisible to the confinement gate)", async () => {
    const runtime = makeRuntime()
    await expect(
      runOcrTool({ source: { kind: "file_path", value: "/etc/passwd" } } as never, { runtime })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/top-level `path`/) })
    expect(runtime.extractFile).not.toHaveBeenCalled()
    expect(runtime.extract).not.toHaveBeenCalled()
  })

  it("requires exactly one of path / source", async () => {
    const runtime = makeRuntime()
    await expect(runOcrTool({}, { runtime })).resolves.toMatchObject({ ok: false })
    await expect(
      runOcrTool({ path: "a.png", source: { kind: "screen" } }, { runtime })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not both/) })
    expect(runtime.extractFile).not.toHaveBeenCalled()
  })

  it("rejects missing, unknown, and unavailable sources", async () => {
    const runtime = makeRuntime()
    await expect(runOcrTool({ source: { kind: "data_url" } }, { runtime })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/source\.value` is required/),
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

const EN = (manifestJson.i18n.locales as Record<string, Record<string, string>>).en

function makeCtx(runtime = makeRuntime()) {
  const registerTool = jest.fn()
  const registerPartRenderer = jest.fn(() => jest.fn())
  const appendMessagePart = jest.fn((): string | null => "message-1")
  const ctx = {
    pluginId: "cognia-ocr",
    logger: { info: jest.fn() },
    agent: { registerTool },
    ocr: runtime,
    chat: { appendMessagePart },
    messagePart: { registerPartRenderer },
    i18n: {
      t: (key: string, params?: Record<string, string | number>) =>
        (EN[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) =>
          params?.[name] !== undefined ? String(params[name]) : m
        ),
    },
  } as unknown as PluginContext
  return { ctx, runtime, registerTool, registerPartRenderer, appendMessagePart }
}

type Hooks = {
  onCommand: (
    command: string,
    args: string[],
    context?: { sessionId?: string }
  ) => Promise<boolean | { handled: boolean; message?: string }>
}

describe("OCR plugin activation", () => {
  it("registers a confined, long-budget tool and the renderer against context-owned APIs", async () => {
    const { ctx, runtime, registerTool, registerPartRenderer } = makeCtx()
    await ocrPluginDefinition.activate(ctx)
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "ocr.extract" }))
    expect(registerPartRenderer).toHaveBeenCalledWith("ocr-result", expect.any(Function))

    const tool = registerTool.mock.calls[0]?.[0]
    // The model-supplied file path is a top-level param the sidecar gate judges.
    expect(tool.definition).toMatchObject({
      access: "read",
      pathParams: ["path"],
      timeoutMs: OCR_TOOL_TIMEOUT_MS,
    })
    expect(tool.definition.description).not.toMatch(/\d+ cloud or on-device/)
    await tool.execute({ source: { kind: "data_url", value: "data:image/png;base64,AA==" } })
    expect(runtime.extract).toHaveBeenCalledTimes(1)
  })

  it("appends the result card to the chat the command was typed in", async () => {
    const { ctx, runtime, appendMessagePart } = makeCtx()
    const hooks = (await ocrPluginDefinition.activate(ctx)) as unknown as Hooks
    expect(await hooks.onCommand("other", [])).toBe(false)
    const outcome = await hooks.onCommand("ocr", ["/tmp/a.png"], { sessionId: "session-7" })
    expect(runtime.runSlashCommand).toHaveBeenCalledWith("/tmp/a.png")
    expect(appendMessagePart).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ocr-result", text: "Hello" }),
      { sessionId: "session-7" }
    )
    expect(outcome).toEqual({ handled: true, message: "Text recognized with mock." })
  })

  it("answers with the recognized text when there is no chat to hold the card", async () => {
    const { ctx, appendMessagePart } = makeCtx()
    appendMessagePart.mockReturnValue(null)
    const hooks = (await ocrPluginDefinition.activate(ctx)) as unknown as Hooks
    const outcome = (await hooks.onCommand("ocr", ["a.png"])) as { message: string }
    expect(appendMessagePart).toHaveBeenCalledWith(expect.anything(), undefined)
    expect(outcome.message).toContain(EN["command.notAttached"])
    expect(outcome.message).toContain("Hello")
  })

  it("relays the host parser's usage text when nothing was recognized", async () => {
    const { ctx, appendMessagePart } = makeCtx(
      makeRuntime({ runSlashCommand: jest.fn(async () => ({ system: "Usage: /ocr <path>" })) })
    )
    const hooks = (await ocrPluginDefinition.activate(ctx)) as unknown as Hooks
    await expect(hooks.onCommand("ocr", [])).resolves.toEqual({
      handled: true,
      message: "Usage: /ocr <path>",
    })
    expect(appendMessagePart).not.toHaveBeenCalled()
  })

  it("reports unavailable OCR (localized) without invoking the slash runtime", async () => {
    const { ctx, runtime } = makeCtx(makeRuntime({ isReady: () => false }))
    const hooks = (await ocrPluginDefinition.activate(ctx)) as unknown as Hooks
    await expect(hooks.onCommand("ocr", [])).resolves.toEqual({
      handled: true,
      message: EN["command.notReady"],
    })
    expect(runtime.runSlashCommand).not.toHaveBeenCalled()
  })

  it("advertises only resolvable, non-file source kinds and a top-level path", () => {
    const schema = TOOL_PARAMETERS as unknown as {
      properties: {
        path: { type: string }
        source: { properties: { kind: { enum: string[] } } }
      }
    }
    expect(schema.properties.source.properties.kind.enum).toEqual(["data_url", "screen"])
    expect(schema.properties.path.type).toBe("string")
  })

  it("declares the permissions its calls need and truthful non-desktop postures", () => {
    const manifest = ocrPluginDefinition.manifest
    // ctx.chat.appendMessagePart + ctx.messagePart.registerPartRenderer.
    expect(manifest.permissions).toEqual(expect.arrayContaining(["session:write", "extension:ui"]))
    expect(manifest.runtimeCompatibility?.browser?.availability).toBe("degraded")
    expect(manifest.runtimeCompatibility?.mobile?.availability).toBe("degraded")
    const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
    expect(Object.keys(locales["zh-CN"]).sort()).toEqual(Object.keys(locales.en).sort())
  })
})
