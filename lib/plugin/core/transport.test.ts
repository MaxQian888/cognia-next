/**
 * Plugin Transport Layer Tests
 */

import type { PluginApiInvokeResponse } from "./transport"

const mockDirectInvoke = jest.fn()
const mockTransportCall = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockDirectInvoke(...args),
}))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockTransportCall(...args) },
}))

import {
  invokePluginApi,
  invokePluginApiBatch,
  getPluginCapabilities,
  isPluginGatewayAvailable,
  grantPluginPermission,
  revokePluginPermission,
  listPluginPermissions,
  PluginGatewayError,
  normalizePluginRuntimeHandshake,
} from "./transport"
import { setActiveRemoteTransport, __resetRoutingForTests } from "@/lib/tauri/transport-routing"

describe("isPluginGatewayAvailable", () => {
  afterEach(() => __resetRoutingForTests())

  it("recognizes an active separated remote host", () => {
    expect(isPluginGatewayAvailable()).toBe(false)
    setActiveRemoteTransport({
      call: jest.fn(),
      subscribe: jest.fn(() => () => {}),
    })
    expect(isPluginGatewayAvailable()).toBe(true)
  })
})

describe("PluginGatewayError", () => {
  it("creates an error with the correct properties", () => {
    const err = new PluginGatewayError({
      code: "NOT_FOUND",
      message: "Plugin not found",
      details: { id: "missing" },
      requestId: "req-1",
      api: "getStatus",
      pluginId: "test-plugin",
    })

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("PluginGatewayError")
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toBe("Plugin not found")
    expect(err.details).toEqual({ id: "missing" })
    expect(err.requestId).toBe("req-1")
    expect(err.api).toBe("getStatus")
    expect(err.pluginId).toBe("test-plugin")
  })
})

describe("normalizePluginRuntimeHandshake", () => {
  it("preserves a current handshake", () => {
    expect(
      normalizePluginRuntimeHandshake(
        {
          sdk_version: "3.0.0",
          protocol_version: "3.0.0",
          contract_version: "2.0.0",
          runtime_id: "python-worker",
          capabilities: ["tools", 1],
          legacy_adapter: false,
        },
        "python"
      )
    ).toMatchObject({
      sdk_version: "3.0.0",
      protocol_version: "3.0.0",
      contract_version: "2.0.0",
      runtime_id: "python-worker",
      capabilities: ["tools"],
      legacy_adapter: false,
    })
  })

  it("marks runtimes without a handshake as legacy", () => {
    expect(normalizePluginRuntimeHandshake({ tool_count: 1 }, "python")).toMatchObject({
      sdk_version: "0.1.0",
      protocol_version: "2.0.0",
      contract_version: "1.0.0",
      runtime_id: "python",
      capabilities: [],
      legacy_adapter: true,
      tool_count: 1,
    })
  })
})

describe("invokePluginApi", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns data on successful response", async () => {
    mockTransportCall.mockResolvedValue({
      requestId: "req-1",
      success: true,
      data: { result: "ok" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    } satisfies PluginApiInvokeResponse)

    const result = await invokePluginApi("my-plugin", "getStatus", { key: "val" })
    expect(result).toEqual({ result: "ok" })
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({
        pluginId: "my-plugin",
        api: "getStatus",
        payload: { key: "val" },
        sdkVersion: "2.0.0",
      }),
    })
    expect(mockDirectInvoke).not.toHaveBeenCalled()
  })

  it("throws PluginGatewayError on failure without retries for non-retryable codes", async () => {
    mockTransportCall.mockResolvedValue({
      requestId: "req-1",
      success: false,
      error: { code: "PERMISSION_DENIED", message: "Not allowed" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    })

    await expect(invokePluginApi("my-plugin", "doThing", {})).rejects.toThrow(PluginGatewayError)
    // Should only invoke once — PERMISSION_DENIED is not retryable
    expect(mockTransportCall).toHaveBeenCalledTimes(1)
  })

  it("retries on TIMEOUT errors up to the retry count", async () => {
    const timeoutResponse = {
      requestId: "req-1",
      success: false,
      error: { code: "TIMEOUT", message: "Timed out" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    }

    mockTransportCall.mockResolvedValue(timeoutResponse)

    await expect(
      invokePluginApi("my-plugin", "slowOp", {}, { retries: 2, retryDelayMs: 1 })
    ).rejects.toThrow(PluginGatewayError)

    // 1 initial + 2 retries = 3 total calls
    expect(mockTransportCall).toHaveBeenCalledTimes(3)
  })

  it("retries on INTERNAL errors", async () => {
    const internalError = {
      requestId: "req-1",
      success: false,
      error: { code: "INTERNAL", message: "Internal error" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    }
    const successResponse = {
      requestId: "req-1",
      success: true,
      data: "recovered",
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    }

    mockTransportCall.mockResolvedValueOnce(internalError).mockResolvedValueOnce(successResponse)

    const result = await invokePluginApi("my-plugin", "op", {}, { retries: 2, retryDelayMs: 1 })
    expect(result).toBe("recovered")
    expect(mockTransportCall).toHaveBeenCalledTimes(2)
  })

  it("uses default sdkVersion 2.0.0", async () => {
    mockTransportCall.mockResolvedValue({ success: true, data: null })

    await invokePluginApi("p", "a", null)
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({ sdkVersion: "2.0.0" }),
    })
  })

  it("allows overriding sdkVersion", async () => {
    mockTransportCall.mockResolvedValue({ success: true, data: null })

    await invokePluginApi("p", "a", null, { sdkVersion: "3.0.0" })
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({ sdkVersion: "3.0.0" }),
    })
  })

  it("falls back to INTERNAL code when response has no error object", async () => {
    mockTransportCall.mockResolvedValue({
      success: false,
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    })

    // With retries=0, it should retry once (default) for INTERNAL then throw
    try {
      await invokePluginApi("p", "a", null, { retries: 0, retryDelayMs: 1 })
      fail("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(PluginGatewayError)
      expect((err as PluginGatewayError).code).toBe("INTERNAL")
    }
  })
})

describe("invokePluginApiBatch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("sends batch requests and returns results", async () => {
    const batchResults = [
      { requestId: "r1", success: true, data: "a", runtimeVersion: "2.0.0", compat: {} },
      { requestId: "r2", success: true, data: "b", runtimeVersion: "2.0.0", compat: {} },
    ]
    mockTransportCall.mockResolvedValue({ success: true, results: batchResults })

    const results = await invokePluginApiBatch("my-plugin", [
      { api: "getA", payload: {} },
      { api: "getB", payload: {} },
    ])

    expect(results).toHaveLength(2)
    expect(results[0].data).toBe("a")
    expect(results[1].data).toBe("b")
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_api_batch_invoke", {
      request: expect.objectContaining({
        pluginId: "my-plugin",
        strategy: "continueOnError",
        sdkVersion: "2.0.0",
      }),
    })
  })

  it("uses abortOnError strategy when specified", async () => {
    mockTransportCall.mockResolvedValue({ success: true, results: [] })

    await invokePluginApiBatch("p", [{ api: "a", payload: null }], {
      strategy: "abortOnError",
    })

    expect(mockTransportCall).toHaveBeenCalledWith("plugin_api_batch_invoke", {
      request: expect.objectContaining({ strategy: "abortOnError" }),
    })
  })
})

describe("getPluginCapabilities", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("invokes the correct command", async () => {
    const caps = [{ api: "storage", supported: true, highRisk: false, requiredPermissions: [] }]
    mockTransportCall.mockResolvedValue(caps)

    const result = await getPluginCapabilities()
    expect(result).toEqual(caps)
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_get_capabilities", undefined)
  })
})

describe("grantPluginPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("routes flat Rust-signature args through the active host transport", async () => {
    mockTransportCall.mockResolvedValue(undefined)

    await grantPluginPermission("my-plugin", "network:fetch")
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_permission_grant", {
      pluginId: "my-plugin",
      permission: "network:fetch",
      grantedBy: "user",
      expiresAt: null,
    })
  })

  it("threads grantedBy and expiresAt through", async () => {
    mockTransportCall.mockResolvedValue(undefined)

    await grantPluginPermission("my-plugin", "filesystem:read", "manifest", "2030-01-01T00:00:00Z")
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_permission_grant", {
      pluginId: "my-plugin",
      permission: "filesystem:read",
      grantedBy: "manifest",
      expiresAt: "2030-01-01T00:00:00Z",
    })
  })

  it("never bypasses remote routing with a direct local Tauri invoke", async () => {
    mockTransportCall.mockResolvedValue(undefined)

    await grantPluginPermission("my-plugin", "notification", "manifest")

    expect(mockTransportCall).toHaveBeenCalledWith("plugin_permission_grant", {
      pluginId: "my-plugin",
      permission: "notification",
      grantedBy: "manifest",
      expiresAt: null,
    })
    expect(mockDirectInvoke).not.toHaveBeenCalled()
  })
})

describe("revokePluginPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("routes flat args through the active host transport", async () => {
    mockTransportCall.mockResolvedValue(undefined)

    await revokePluginPermission("my-plugin", "network:fetch")
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_permission_revoke", {
      pluginId: "my-plugin",
      permission: "network:fetch",
    })
  })
})

describe("listPluginPermissions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the active host permission list", async () => {
    mockTransportCall.mockResolvedValue([
      { permission: "network:fetch", grantedBy: "manifest" },
      "fs:read",
      { malformed: true },
    ])

    const perms = await listPluginPermissions("my-plugin")
    expect(perms).toEqual(["network:fetch", "fs:read"])
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_permission_list", {
      pluginId: "my-plugin",
    })
  })
})

// ── W6.3: retry only idempotent APIs by default ──────────────────────────────
describe("idempotency-aware retry (W6.3)", () => {
  beforeEach(() => {
    mockTransportCall.mockReset()
  })

  const timeoutResponse = {
    requestId: "r",
    success: false,
    error: { code: "TIMEOUT", message: "slow" },
    runtimeVersion: "1",
    compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
  }

  it("retries a read-shaped api on TIMEOUT", async () => {
    mockTransportCall
      .mockResolvedValueOnce(timeoutResponse)
      .mockResolvedValueOnce({ ...timeoutResponse, success: true, data: 42, error: undefined })
    await expect(invokePluginApi("p", "secrets:get", {}, { retryDelayMs: 1 })).resolves.toBe(42)
    expect(mockTransportCall).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry a side-effecting api by default", async () => {
    mockTransportCall.mockResolvedValue(timeoutResponse)
    await expect(invokePluginApi("p", "secrets:set", {}, { retryDelayMs: 1 })).rejects.toThrow()
    expect(mockTransportCall).toHaveBeenCalledTimes(1)
  })

  it("honours an explicit idempotent override", async () => {
    mockTransportCall
      .mockResolvedValueOnce(timeoutResponse)
      .mockResolvedValueOnce({ ...timeoutResponse, success: true, data: "ok", error: undefined })
    await expect(
      invokePluginApi("p", "cache:set", {}, { idempotent: true, retryDelayMs: 1 })
    ).resolves.toBe("ok")
    expect(mockTransportCall).toHaveBeenCalledTimes(2)
  })
})
