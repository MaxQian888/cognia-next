/**
 * Tests for plugin-tool-ipc.ts
 * Renderer-side IPC handler for `plugin_tool_exec` events from the sidecar.
 */

import {
  __setPluginToolResolverForTesting,
  handlePluginToolExec,
  type PluginToolExecRequest,
  type PluginToolResolver,
} from "./plugin-tool-ipc"

function makeRequest(overrides?: Partial<PluginToolExecRequest>): PluginToolExecRequest {
  return {
    type: "plugin_tool_exec",
    sessionId: "session-1",
    toolUseId: "use-1",
    name: "demo_tool",
    args: { hello: "world" },
    ...overrides,
  }
}

describe("handlePluginToolExec", () => {
  afterEach(() => {
    __setPluginToolResolverForTesting(null)
  })

  it("returns a successful response with the execute() result", async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true })
    const resolver: PluginToolResolver = {
      getTool: () => ({ pluginId: "plug-a", execute }),
      getPluginConfig: () => ({ apiKey: "secret" }),
    }
    __setPluginToolResolverForTesting(resolver)

    const response = await handlePluginToolExec(makeRequest())

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      result: { ok: true },
    })
    expect(execute).toHaveBeenCalledWith(
      { hello: "world" },
      expect.objectContaining({
        sessionId: "session-1",
        config: { apiKey: "secret" },
      })
    )
  })

  it("returns an error response when the tool is unknown", async () => {
    const resolver: PluginToolResolver = {
      getTool: () => undefined,
    }
    __setPluginToolResolverForTesting(resolver)

    const response = await handlePluginToolExec(makeRequest({ name: "missing" }))

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      error: "plugin tool not found: missing",
    })
  })

  it("captures Error instances thrown from execute() and surfaces .message", async () => {
    const execute = jest.fn().mockRejectedValue(new Error("boom"))
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response).toEqual({
      type: "plugin_tool_response",
      sessionId: "session-1",
      toolUseId: "use-1",
      error: "boom",
    })
  })

  it("coerces non-Error throws to a string for the error field", async () => {
    const execute = jest.fn().mockRejectedValue("plain string failure")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response.error).toBe("plain string failure")
    expect(response.result).toBeUndefined()
  })

  it("defaults the plugin config to {} when the resolver omits getPluginConfig", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
      // getPluginConfig intentionally omitted
    })

    await handlePluginToolExec(makeRequest())

    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ config: {} }))
  })

  it("never throws even when the resolver itself throws synchronously", async () => {
    __setPluginToolResolverForTesting({
      getTool: () => {
        throw new Error("resolver exploded")
      },
    })

    const response = await handlePluginToolExec(makeRequest())

    expect(response.error).toBe("resolver exploded")
    expect(response.result).toBeUndefined()
  })

  it("threads the sessionId into the execution context", async () => {
    const execute = jest.fn().mockResolvedValue("ok")
    __setPluginToolResolverForTesting({
      getTool: () => ({ pluginId: "p", execute }),
    })

    await handlePluginToolExec(makeRequest({ sessionId: "alt-session" }))

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "alt-session" })
    )
  })
})
