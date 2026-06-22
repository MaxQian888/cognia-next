// ADR-0028 / T3 — WASM runtime unit tests.
//
// `defaultWasmRuntimeFactory` is exercised against a tiny hand-rolled
// core module exporting `ping` (returns 42). The runtime factory
// override is exercised separately to confirm dispatch + preopen
// resolution.

import { loadWasmPlugin, type WasmRuntimeFactory } from "./wasm-runtime"

jest.mock("@/lib/plugin/security/wasm-grant", () => ({
  getGrantedPreopens: jest.fn(async (_pluginId: string) => []),
  verifyPreopenAllowedForCall: jest.fn(async () => undefined),
}))

import { getGrantedPreopens, verifyPreopenAllowedForCall } from "@/lib/plugin/security/wasm-grant"

const mockPreopens = getGrantedPreopens as jest.MockedFunction<typeof getGrantedPreopens>
const mockVerifyPreopenAllowedForCall = verifyPreopenAllowedForCall as jest.MockedFunction<
  typeof verifyPreopenAllowedForCall
>

// Hand-built minimal core wasm module that exports `ping` returning 42.
// Sections:
//   type:   ( ) -> i32
//   func 0: type 0
//   export: "ping" func 0
//   code:   i32.const 42, end
const PING_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00, // magic + version
  0x01,
  0x05,
  0x01,
  0x60,
  0x00,
  0x01,
  0x7f, // type section
  0x03,
  0x02,
  0x01,
  0x00, // function section
  0x07,
  0x08,
  0x01,
  0x04,
  0x70,
  0x69,
  0x6e,
  0x67,
  0x00,
  0x00, // export "ping"
  0x0a,
  0x06,
  0x01,
  0x04,
  0x00,
  0x41,
  0x2a,
  0x0b, // code: i32.const 42, end
])

beforeEach(() => {
  mockPreopens.mockReset()
  mockPreopens.mockResolvedValue([])
  mockVerifyPreopenAllowedForCall.mockReset()
  mockVerifyPreopenAllowedForCall.mockResolvedValue(undefined)
})

describe("loadWasmPlugin", () => {
  it("instantiates a core module and exposes exports through call()", async () => {
    const handle = await loadWasmPlugin("test-plugin", {
      kind: "bytes",
      data: PING_MODULE,
    })
    const result = await handle.call("ping")
    expect(result).toBe(42)
    expect(handle.pluginId).toBe("test-plugin")
    expect(handle.preopens).toEqual([])
    await handle.dispose()
  })

  it("loads a module passed as base64", async () => {
    const base64 = Buffer.from(PING_MODULE).toString("base64")
    const handle = await loadWasmPlugin("base64-plugin", {
      kind: "base64",
      data: base64,
    })
    expect(await handle.call("ping")).toBe(42)
    await handle.dispose()
  })

  it("decodes base64 via Buffer when atob is unavailable", async () => {
    const originalAtob = globalThis.atob
    Object.defineProperty(globalThis, "atob", {
      value: undefined,
      configurable: true,
    })
    try {
      const handle = await loadWasmPlugin("buffer-base64-plugin", {
        kind: "base64",
        data: Buffer.from(PING_MODULE).toString("base64"),
      })

      expect(await handle.call("ping")).toBe(42)
      await handle.dispose()
    } finally {
      Object.defineProperty(globalThis, "atob", {
        value: originalAtob,
        configurable: true,
      })
    }
  })

  it("rejects unknown exports", async () => {
    const handle = await loadWasmPlugin("test-plugin", {
      kind: "bytes",
      data: PING_MODULE,
    })
    await expect(handle.call("nope")).rejects.toThrow(/export not found: nope/)
    await handle.dispose()
  })

  it("throws after dispose", async () => {
    const handle = await loadWasmPlugin("test-plugin", {
      kind: "bytes",
      data: PING_MODULE,
    })
    await handle.dispose()
    await expect(handle.call("ping")).rejects.toThrow(/disposed/)
  })

  it("rejects empty method names before revalidating preopens", async () => {
    const handle = await loadWasmPlugin("test-plugin", {
      kind: "bytes",
      data: PING_MODULE,
    })

    await expect(handle.call("")).rejects.toThrow(/method name is required/)
    expect(mockVerifyPreopenAllowedForCall).not.toHaveBeenCalled()
    await handle.dispose()
  })

  it("accepts ArrayBuffer-backed core module sources", async () => {
    const bytes = PING_MODULE.buffer.slice(
      PING_MODULE.byteOffset,
      PING_MODULE.byteOffset + PING_MODULE.byteLength
    )
    const handle = await loadWasmPlugin("array-buffer-plugin", {
      kind: "bytes",
      data: bytes,
    })

    expect(await handle.call("ping")).toBe(42)
    await handle.dispose()
  })

  it("surfaces a structured error for component-model modules without a wired jco runtime", async () => {
    const componentHeader = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])

    await expect(
      loadWasmPlugin("component-plugin", {
        kind: "bytes",
        data: componentHeader,
      })
    ).rejects.toThrow(/jco|component plugins/)
  })

  it("threads preopens through to the runtime factory", async () => {
    mockPreopens.mockResolvedValue(["/data", "/scratch"])
    const factory: WasmRuntimeFactory = jest.fn(async () => ({
      async call() {
        return "ok"
      },
      async dispose() {},
    }))
    const handle = await loadWasmPlugin(
      "factory-plugin",
      { kind: "bytes", data: new Uint8Array() },
      { runtimeFactory: factory }
    )
    expect(handle.preopens).toEqual(["/data", "/scratch"])
    expect(factory).toHaveBeenCalledWith({
      pluginId: "factory-plugin",
      source: { kind: "bytes", data: expect.any(Uint8Array) },
      preopens: ["/data", "/scratch"],
    })
    await handle.dispose()
  })

  it("rejects when pluginId is empty", async () => {
    await expect(loadWasmPlugin("", { kind: "bytes", data: PING_MODULE })).rejects.toThrow(
      /pluginId is required/
    )
  })

  it("dispose() is idempotent", async () => {
    const dispose = jest.fn(async () => {})
    const factory: WasmRuntimeFactory = jest.fn(async () => ({
      async call() {
        return null
      },
      dispose,
    }))
    const handle = await loadWasmPlugin(
      "id-plugin",
      { kind: "bytes", data: new Uint8Array() },
      { runtimeFactory: factory }
    )
    await handle.dispose()
    await handle.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("dispose() remains idempotent even when the underlying instance.dispose rejects", async () => {
    // The outer handle sets `disposed=true` BEFORE awaiting the underlying
    // dispose, so the first throw propagates exactly once and subsequent
    // calls short-circuit. This guards against a regression that would
    // re-run a failing teardown on every retry — a real risk when the
    // plugin loader's retry / cleanup path loops on transient failures.
    const dispose = jest.fn(async () => {
      throw new Error("teardown explosion")
    })
    const factory: WasmRuntimeFactory = jest.fn(async () => ({
      async call() {
        return null
      },
      dispose,
    }))
    const handle = await loadWasmPlugin(
      "id-plugin-err",
      { kind: "bytes", data: new Uint8Array() },
      { runtimeFactory: factory }
    )
    await expect(handle.dispose()).rejects.toThrow("teardown explosion")
    // Second call: no-op, no re-throw — the disposed sentinel guards us.
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
    // Subsequent call() still rejects with the disposed sentinel.
    await expect(handle.call("ping")).rejects.toThrow(/disposed/)
  })

  it("preopens reflect the grant resolver override", async () => {
    const resolver = jest.fn(() => ["/only-here"])
    const factory: WasmRuntimeFactory = jest.fn(async () => ({
      async call() {
        return null
      },
      async dispose() {},
    }))
    const handle = await loadWasmPlugin(
      "resolver-plugin",
      { kind: "bytes", data: new Uint8Array() },
      { runtimeFactory: factory, preopensResolver: resolver }
    )
    expect(handle.preopens).toEqual(["/only-here"])
    expect(resolver).toHaveBeenCalledWith("resolver-plugin")
  })

  it("revalidates loaded preopens against the ledger before every call", async () => {
    mockPreopens.mockResolvedValue(["/data"])
    mockVerifyPreopenAllowedForCall.mockRejectedValueOnce(new Error("revoked"))
    const factory: WasmRuntimeFactory = jest.fn(async () => ({
      call: jest.fn(async () => "should-not-run"),
      async dispose() {},
    }))
    const handle = await loadWasmPlugin(
      "gate-plugin",
      { kind: "bytes", data: new Uint8Array() },
      { runtimeFactory: factory }
    )

    await expect(handle.call("ping")).rejects.toThrow("revoked")
    expect(mockVerifyPreopenAllowedForCall).toHaveBeenCalledWith("gate-plugin", ["/data"])
  })
})
