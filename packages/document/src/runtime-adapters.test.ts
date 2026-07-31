/** @jest-environment jsdom */
import {
  documentTransport,
  getDocumentLogger,
  isTauri,
  resetDocumentRuntimeAdaptersForTesting,
  setDocumentRuntimeAdapters,
} from "./runtime-adapters"

describe("document runtime adapters", () => {
  beforeEach(() => {
    resetDocumentRuntimeAdaptersForTesting()
    delete (globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  afterEach(() => {
    resetDocumentRuntimeAdaptersForTesting()
    delete (globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("detects Tauri from the default window marker", () => {
    expect(isTauri()).toBe(false)
    ;(globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(isTauri()).toBe(true)
  })

  it("uses injected Tauri and transport adapters", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })

    setDocumentRuntimeAdapters({
      isTauri: () => true,
      transport: { call },
    })

    await expect(documentTransport.call("parse_document_native", { payload: 1 })).resolves.toEqual({
      ok: true,
    })
    expect(isTauri()).toBe(true)
    expect(call).toHaveBeenCalledWith("parse_document_native", { payload: 1 })
  })

  it("forwards logger calls through the currently wired logger", () => {
    const first = { warn: jest.fn() }
    const second = { warn: jest.fn() }
    const log = getDocumentLogger()

    setDocumentRuntimeAdapters({ logger: first })
    log.warn("first", { source: "markdown" })

    setDocumentRuntimeAdapters({ logger: second })
    log.warn("second", { source: "html" })

    expect(first.warn).toHaveBeenCalledWith("first", { source: "markdown" })
    expect(second.warn).toHaveBeenCalledWith("second", { source: "html" })
  })

  it("throws a clear error when native transport is not wired", async () => {
    await expect(documentTransport.call("parse_document_native", {})).rejects.toThrow(/not wired/i)
  })
})
