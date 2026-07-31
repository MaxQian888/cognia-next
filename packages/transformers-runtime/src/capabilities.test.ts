import { getTransformersCapabilities } from "./capabilities"

describe("getTransformersCapabilities", () => {
  const originalWorker = globalThis.Worker

  afterEach(() => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker })
  })

  it("detects worker and WebGPU support without creating either runtime", () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class {} })
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: {} },
    })

    expect(getTransformersCapabilities()).toEqual({
      available: true,
      worker: true,
      webgpu: true,
      wasm: true,
      recommendedDevice: "webgpu",
    })
  })

  it("falls back to WASM and reports unavailable outside a worker-capable browser", () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} })

    expect(getTransformersCapabilities()).toMatchObject({
      available: false,
      worker: false,
      webgpu: false,
      recommendedDevice: "wasm",
    })
  })
})
