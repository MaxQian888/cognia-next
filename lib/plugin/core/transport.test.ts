/**
 * Plugin Transport Layer Tests
 */

import type { PluginApiInvokeResponse } from "./transport"

const mockInvoke = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import {
  invokePluginApi,
  invokePluginApiBatch,
  getPluginCapabilities,
  grantPluginPermission,
  revokePluginPermission,
  listPluginPermissions,
  PluginGatewayError,
} from "./transport"

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

describe("invokePluginApi", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns data on successful response", async () => {
    mockInvoke.mockResolvedValue({
      requestId: "req-1",
      success: true,
      data: { result: "ok" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    } satisfies PluginApiInvokeResponse)

    const result = await invokePluginApi("my-plugin", "getStatus", { key: "val" })
    expect(result).toEqual({ result: "ok" })
    expect(mockInvoke).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({
        pluginId: "my-plugin",
        api: "getStatus",
        payload: { key: "val" },
        sdkVersion: "2.0.0",
      }),
    })
  })

  it("throws PluginGatewayError on failure without retries for non-retryable codes", async () => {
    mockInvoke.mockResolvedValue({
      requestId: "req-1",
      success: false,
      error: { code: "PERMISSION_DENIED", message: "Not allowed" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    })

    await expect(invokePluginApi("my-plugin", "doThing", {})).rejects.toThrow(PluginGatewayError)
    // Should only invoke once — PERMISSION_DENIED is not retryable
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("retries on TIMEOUT errors up to the retry count", async () => {
    const timeoutResponse = {
      requestId: "req-1",
      success: false,
      error: { code: "TIMEOUT", message: "Timed out" },
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "1.0.0", compatible: true },
    }

    mockInvoke.mockResolvedValue(timeoutResponse)

    await expect(
      invokePluginApi("my-plugin", "slowOp", {}, { retries: 2, retryDelayMs: 1 })
    ).rejects.toThrow(PluginGatewayError)

    // 1 initial + 2 retries = 3 total calls
    expect(mockInvoke).toHaveBeenCalledTimes(3)
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

    mockInvoke.mockResolvedValueOnce(internalError).mockResolvedValueOnce(successResponse)

    const result = await invokePluginApi("my-plugin", "op", {}, { retries: 2, retryDelayMs: 1 })
    expect(result).toBe("recovered")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("uses default sdkVersion 2.0.0", async () => {
    mockInvoke.mockResolvedValue({ success: true, data: null })

    await invokePluginApi("p", "a", null)
    expect(mockInvoke).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({ sdkVersion: "2.0.0" }),
    })
  })

  it("allows overriding sdkVersion", async () => {
    mockInvoke.mockResolvedValue({ success: true, data: null })

    await invokePluginApi("p", "a", null, { sdkVersion: "3.0.0" })
    expect(mockInvoke).toHaveBeenCalledWith("plugin_api_invoke", {
      request: expect.objectContaining({ sdkVersion: "3.0.0" }),
    })
  })

  it("falls back to INTERNAL code when response has no error object", async () => {
    mockInvoke.mockResolvedValue({
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
    mockInvoke.mockResolvedValue({ success: true, results: batchResults })

    const results = await invokePluginApiBatch("my-plugin", [
      { api: "getA", payload: {} },
      { api: "getB", payload: {} },
    ])

    expect(results).toHaveLength(2)
    expect(results[0].data).toBe("a")
    expect(results[1].data).toBe("b")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_api_batch_invoke", {
      request: expect.objectContaining({
        pluginId: "my-plugin",
        strategy: "continueOnError",
        sdkVersion: "2.0.0",
      }),
    })
  })

  it("uses abortOnError strategy when specified", async () => {
    mockInvoke.mockResolvedValue({ success: true, results: [] })

    await invokePluginApiBatch("p", [{ api: "a", payload: null }], {
      strategy: "abortOnError",
    })

    expect(mockInvoke).toHaveBeenCalledWith("plugin_api_batch_invoke", {
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
    mockInvoke.mockResolvedValue(caps)

    const result = await getPluginCapabilities()
    expect(result).toEqual(caps)
    expect(mockInvoke).toHaveBeenCalledWith("plugin_get_capabilities")
  })
})

describe("grantPluginPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("invokes the correct command", async () => {
    mockInvoke.mockResolvedValue(undefined)

    await grantPluginPermission("my-plugin", "network:fetch")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_permission_grant", {
      request: { pluginId: "my-plugin", permission: "network:fetch" },
    })
  })
})

describe("revokePluginPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("invokes the correct command", async () => {
    mockInvoke.mockResolvedValue(undefined)

    await revokePluginPermission("my-plugin", "network:fetch")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_permission_revoke", {
      request: { pluginId: "my-plugin", permission: "network:fetch" },
    })
  })
})

describe("listPluginPermissions", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns permission list", async () => {
    mockInvoke.mockResolvedValue(["network:fetch", "fs:read"])

    const perms = await listPluginPermissions("my-plugin")
    expect(perms).toEqual(["network:fetch", "fs:read"])
    expect(mockInvoke).toHaveBeenCalledWith("plugin_permission_list", { pluginId: "my-plugin" })
  })
})
