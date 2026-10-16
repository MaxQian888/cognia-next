/** @jest-environment jsdom */
import { BrowserSessionError } from "@/lib/browser/session-types"

import {
  EXTENSION_UNSUPPORTED_FEATURES,
  ExtensionBrowserEngine,
  ExtensionBrowserOpError,
  bindExtensionSession,
  extensionBindingFor,
  extensionEngineFor,
  mediaTypeForPath,
  resetExtensionBindings,
  unbindExtensionSession,
  type ExtensionTransport,
} from "./extension-engine"

function harness(answer: (operation: string) => unknown = () => ({ ok: true })) {
  const calls: Parameters<ExtensionTransport>[0][] = []
  const transport: ExtensionTransport = async (input) => {
    calls.push(input)
    const value = answer(input.operation)
    if (value instanceof Error || (value && typeof value === "object" && "code" in value)) {
      throw value
    }
    return value
  }
  const engine = new ExtensionBrowserEngine({
    binding: { deviceId: "browser-a", tabId: 42 },
    chatSessionId: "session-1",
    transport,
    readFile: async (path) => {
      if (path.endsWith("missing.png")) throw new Error("ENOENT")
      if (path.endsWith("huge.bin")) return new Uint8Array(10 * 1024 * 1024 + 1)
      return new TextEncoder().encode(`bytes of ${path}`)
    },
  })
  return { engine, calls }
}

afterEach(() => {
  resetExtensionBindings()
})

describe("ExtensionBrowserEngine", () => {
  it("frames every operation with the conversation and its starting tab", async () => {
    const { engine, calls } = harness()
    await engine.act("r12", "click", { modifiers: ["Shift"] })
    expect(calls).toEqual([
      {
        deviceId: "browser-a",
        operation: "act",
        args: {
          session: "session-1",
          startTabId: 42,
          ref: "r12",
          action: "click",
          args: { modifiers: ["Shift"] },
        },
        timeoutMs: 30_000,
      },
    ])
    expect(engine.backend).toBe("extension")
  })

  it("gives waits their own budget plus slack, within the ceiling", async () => {
    const { engine, calls } = harness()
    await engine.waitForText("Done", { timeoutMs: 45_000 })
    await engine.waitForLoad({ timeoutMs: 500_000 })
    expect(calls.map((call) => call.timeoutMs)).toEqual([50_000, 120_000])
  })

  it("keeps the browser's refusal codes", async () => {
    const { engine } = harness(() => ({
      code: "browser_site_permission_required",
      message: "example.com needs a decision",
    }))
    const refusal = await engine.snapshot().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ExtensionBrowserOpError)
    expect(refusal).toMatchObject({ code: "browser_site_permission_required" })

    const { engine: unsupported } = harness(() => ({
      code: "browser_feature_unsupported",
      message: "no",
    }))
    await expect(unsupported.getPage()).rejects.toBeInstanceOf(BrowserSessionError)
  })

  it("refuses what needs the debugger, naming where it is available", async () => {
    const { engine, calls } = harness()
    for (const attempt of [
      () => engine.pdf(),
      () => engine.emulate({ reset: true }),
      () => engine.networkRequest("req-1"),
      () => engine.detectLoginForms(),
      () => engine.fillCredential({ credentialId: "c" } as never),
      () => engine.listExtensions(),
      () => engine.openExtension("x", "popup"),
      () => engine.saveDownload("d"),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(BrowserSessionError)
      expect((error as BrowserSessionError).code).toBe("browser_feature_unsupported")
      expect((error as Error).message).toContain("user-chrome")
    }
    expect(calls).toEqual([])
    expect(Object.keys(EXTENSION_UNSUPPORTED_FEATURES)).toHaveLength(6)
  })

  it("reads upload files on the Host and sends their bytes", async () => {
    const { engine, calls } = harness()
    await engine.setFiles("r3", ["/tmp/a/report.pdf", "C:\\\\docs\\\\shot.PNG"])
    const args = calls[0]?.args as {
      files: { name: string; mediaType: string; dataBase64: string }[]
    }
    expect(calls[0]?.operation).toBe("set_files")
    expect(args.files.map((file) => [file.name, file.mediaType])).toEqual([
      ["report.pdf", "application/pdf"],
      ["shot.PNG", "image/png"],
    ])
    expect(atob(args.files[0]?.dataBase64 ?? "")).toBe("bytes of /tmp/a/report.pdf")
  })

  it("refuses unreadable, oversized or too many uploads before sending", async () => {
    const { engine, calls } = harness()
    await expect(engine.setFiles("r3", ["/tmp/missing.png"])).rejects.toMatchObject({
      code: "browser_upload_unreadable",
    })
    await expect(engine.setFiles("r3", ["/tmp/huge.bin"])).rejects.toMatchObject({
      code: "browser_upload_too_large",
    })
    await expect(
      engine.setFiles(
        "r3",
        Array.from({ length: 7 }, (_, index) => `/tmp/${index}.txt`)
      )
    ).rejects.toMatchObject({ code: "browser_upload_too_large" })
    expect(calls).toEqual([])
  })
})

describe("mediaTypeForPath", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(mediaTypeForPath("a.JPEG")).toBe("image/jpeg")
    expect(mediaTypeForPath("a.xlsx")).toContain("spreadsheetml")
    expect(mediaTypeForPath("no-extension")).toBe("application/octet-stream")
  })
})

describe("conversation bindings", () => {
  it("binds, reads and unbinds a conversation", () => {
    expect(extensionBindingFor("session-1")).toBeNull()
    bindExtensionSession("session-1", { deviceId: "browser-a", tabId: 7 })
    expect(extensionBindingFor("session-1")).toEqual({ deviceId: "browser-a", tabId: 7 })
    expect(extensionBindingFor(undefined)).toBeNull()
    unbindExtensionSession("session-1")
    expect(extensionBindingFor("session-1")).toBeNull()
  })

  it("builds an engine only for a bound conversation", () => {
    expect(() => extensionEngineFor("session-1")).toThrow(BrowserSessionError)
    expect(() => extensionEngineFor(undefined)).toThrow(BrowserSessionError)
    bindExtensionSession("session-1", { deviceId: "browser-a" })
    const engine = extensionEngineFor("session-1")
    expect(engine.deviceId).toBe("browser-a")
  })
})
