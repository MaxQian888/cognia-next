import { ensureLive2dPluginRegistered, resetLive2dPluginForTests } from "./register-plugin"

describe("ensureLive2dPluginRegistered", () => {
  beforeEach(() => {
    resetLive2dPluginForTests()
  })

  it("registers the Live2D plugin with pixi's extension registry", async () => {
    const add = jest.fn()
    const Live2DPlugin = { id: "live2d" }
    const importPixi = jest.fn(() => Promise.resolve({ extensions: { add } }))
    const importEngine = jest.fn(() => Promise.resolve({ Live2DPlugin }))

    await ensureLive2dPluginRegistered({ importPixi, importEngine })

    expect(importPixi).toHaveBeenCalledTimes(1)
    expect(importEngine).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(Live2DPlugin)
  })

  it("registers only once across repeat calls (idempotent)", async () => {
    const add = jest.fn()
    const importPixi = jest.fn(() => Promise.resolve({ extensions: { add } }))
    const importEngine = jest.fn(() => Promise.resolve({ Live2DPlugin: {} }))

    await ensureLive2dPluginRegistered({ importPixi, importEngine })
    await ensureLive2dPluginRegistered({ importPixi, importEngine })

    // Second call short-circuits on the guard — no re-import, no double add
    // (pixi's real `extensions.add` warns on a duplicate registration).
    expect(importPixi).toHaveBeenCalledTimes(1)
    expect(importEngine).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it("re-registers after resetLive2dPluginForTests clears the guard", async () => {
    const add = jest.fn()
    const deps = {
      importPixi: jest.fn(() => Promise.resolve({ extensions: { add } })),
      importEngine: jest.fn(() => Promise.resolve({ Live2DPlugin: {} })),
    }

    await ensureLive2dPluginRegistered(deps)
    resetLive2dPluginForTests()
    await ensureLive2dPluginRegistered(deps)

    expect(add).toHaveBeenCalledTimes(2)
  })

  it("propagates an import failure and stays unregistered so a retry can register", async () => {
    await expect(
      ensureLive2dPluginRegistered({
        importPixi: jest.fn(() => Promise.reject(new Error("no pixi"))),
        importEngine: jest.fn(() => Promise.resolve({ Live2DPlugin: {} })),
      })
    ).rejects.toThrow("no pixi")

    // The guard never latched, so a later successful call still registers.
    const add = jest.fn()
    await ensureLive2dPluginRegistered({
      importPixi: jest.fn(() => Promise.resolve({ extensions: { add } })),
      importEngine: jest.fn(() => Promise.resolve({ Live2DPlugin: {} })),
    })
    expect(add).toHaveBeenCalledTimes(1)
  })

  it("falls back to importing pixi.js and the engine when no deps are injected", async () => {
    // Default importers resolve to the repo's manual jest mocks (pixi.js +
    // untitled-pixi-live2d-engine/cubism), exercising the production `??` paths.
    const pixi = (await import("pixi.js")) as unknown as {
      extensions: { add: jest.Mock }
    }
    const { Live2DPlugin } = (await import("untitled-pixi-live2d-engine/cubism")) as unknown as {
      Live2DPlugin: unknown
    }
    pixi.extensions.add.mockClear()

    await ensureLive2dPluginRegistered()

    expect(pixi.extensions.add).toHaveBeenCalledWith(Live2DPlugin)
  })
})
