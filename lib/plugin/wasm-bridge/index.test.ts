import * as bridge from "./index"

describe("WASM bridge public surface", () => {
  it("exports the renderer protocol, registry, errors, and installer", () => {
    expect(bridge).toEqual(
      expect.objectContaining({
        WasmBridgeError: expect.any(Function),
        toBridgeError: expect.any(Function),
        parseRendererRequest: expect.any(Function),
        beginRequest: expect.any(Function),
        cancelRequest: expect.any(Function),
        dispatchWasmOperation: expect.any(Function),
        installWasmRendererRequestSource: expect.any(Function),
      })
    )
    expect(bridge.WASM_RENDERER_REQUEST_EVENT).toBe("plugin-wasm://renderer-request")
    expect(bridge.WASM_RENDERER_RESPONSE_COMMAND).toBe("plugin_wasm_renderer_response")
  })
})
