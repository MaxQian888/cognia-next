import { render, waitFor, act } from "@testing-library/react"
import type { PetBones, PetStage } from "@/types/pet"

// pixi.js and the engine loader are WebGL/Cubism runtimes jsdom can't host.
// Mock the loader module and the DB; pixi.js is mocked inline with shared
// jest.fn handles so each lifecycle call can be asserted directly.
const addChild = jest.fn()
const resize = jest.fn()
const tickerStop = jest.fn()
const tickerStart = jest.fn()
const tickerAdd = jest.fn()
const tickerRemove = jest.fn()
const appDestroy = jest.fn()
const appInit = jest.fn(() => Promise.resolve())
const appRender = jest.fn()

const tickerState: { maxFPS?: number } = {}
jest.mock("pixi.js", () => ({
  Application: class {
    stage = { addChild }
    renderer = { resize }
    ticker = Object.assign(tickerState, {
      stop: tickerStop,
      start: tickerStart,
      add: tickerAdd,
      remove: tickerRemove,
    })
    init = appInit
    destroy = appDestroy
    render = appRender
  },
}))

/** Invoke the guarded render listener the canvas registered on the ticker. */
function runGuardedRender() {
  const cb = tickerAdd.mock.calls.at(-1)?.[0] as (() => void) | undefined
  cb?.()
}

const load = jest.fn()
jest.mock("@/lib/pet/live2d/loader", () => ({
  createLive2dLoader: () => ({ load }),
}))

const loadLive2dSkinAsset = jest.fn()
jest.mock("@/lib/pet/skin-assets", () => ({
  loadLive2dSkinAsset: (...a: unknown[]) => loadLive2dSkinAsset(...a),
}))

// The canvas registers the Live2D render pipe before building the renderer; the
// registrar imports pixi + the engine, both unavailable in jsdom. Stub it and
// keep a handle so the "registers before init" ordering can be asserted.
const ensureLive2dPluginRegistered = jest.fn((..._args: unknown[]) => Promise.resolve())
jest.mock("@/lib/pet/live2d/register-plugin", () => ({
  ensureLive2dPluginRegistered: (...a: unknown[]) => ensureLive2dPluginRegistered(...a),
}))

import Live2dCanvas from "./live2d-canvas"

const bones = {} as PetBones
const stage: PetStage = "baby"

function makeLoadedModel() {
  return {
    width: 200,
    height: 400,
    anchor: { set: jest.fn() },
    position: { set: jest.fn() },
    scale: { set: jest.fn() },
    motion: jest.fn(),
    expression: jest.fn(),
    internalModel: {
      motionManager: { stopAllMotions: jest.fn() },
      on: jest.fn(),
      off: jest.fn(),
      coreModel: { setParameterValueById: jest.fn() },
    },
  }
}

const row = {
  id: "m1",
  name: "Hiyori",
  source: "import" as const,
  settingsPath: "Hiyori.model3.json",
  motionGroups: ["Idle", "Tap"],
  expressionIds: ["happy"],
  totalBytes: 1000,
  createdAt: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  tickerState.maxFPS = undefined
  loadLive2dSkinAsset.mockResolvedValue({
    row,
    entries: [{ path: "Hiyori.model3.json", blob: new Blob(["{}"]) }],
  })
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: jest.fn(() => "data:image/png;base64,snapshot"),
  })
})

function renderCanvas(props: Partial<React.ComponentProps<typeof Live2dCanvas>> = {}) {
  return render(
    <Live2dCanvas
      modelId="m1"
      bones={bones}
      stage={stage}
      state="idle"
      oneShot={null}
      reducedMotion={false}
      size={96}
      {...props}
    />
  )
}

describe("Live2dCanvas", () => {
  it("mounts the model and adds it to the pixi stage on success", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalledWith(loaded))
    expect(appInit).toHaveBeenCalled()
    // The render pipe must be registered BEFORE the renderer is built, else the
    // engine lazily self-registers and warns every frame (the dev-server OOM).
    expect(ensureLive2dPluginRegistered).toHaveBeenCalled()
    expect(ensureLive2dPluginRegistered.mock.invocationCallOrder[0]).toBeLessThan(
      appInit.mock.invocationCallOrder[0]
    )
    // fitModel centers + scales the model (after a reset-to-1 measurement pass).
    expect(loaded.anchor.set).toHaveBeenCalledWith(0.5, 0.5)
    expect(loaded.position.set).toHaveBeenCalledWith(48, 48)
    expect(loaded.scale.set).toHaveBeenCalledWith(96 / 400, 96 / 400)
  })

  it("registers the lip-sync frame handler while speaking", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas({ speaking: true })
    await waitFor(() =>
      expect(loaded.internalModel.on).toHaveBeenCalledWith(
        "beforeModelUpdate",
        expect.any(Function)
      )
    )
  })

  it("does not register lip-sync while paused even when speaking", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas({ speaking: true, paused: true })
    await waitFor(() => expect(addChild).toHaveBeenCalledWith(loaded))
    expect(loaded.internalModel.on).not.toHaveBeenCalled()
  })

  it("falls back to scale 1 for a zero-sized model", async () => {
    const loaded = makeLoadedModel()
    loaded.width = 0
    loaded.height = 0
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas()
    await waitFor(() => expect(loaded.scale.set).toHaveBeenCalledWith(1, 1))
  })

  it("mirrors the model horizontally when facing left", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas({ locomotion: { mode: "walking", facing: "left" } })
    await waitFor(() => expect(loaded.scale.set).toHaveBeenCalledWith(-(96 / 400), 96 / 400))
  })

  it("applies the per-model transform on top of the fit", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas({ transform: { scale: 1.5, offsetX: 0.1, offsetY: -0.1 } })
    // The transform effect lands once the model state commits.
    const expectedScale = (96 / 400) * 1.5
    await waitFor(() => expect(loaded.scale.set).toHaveBeenCalledWith(expectedScale, expectedScale))
    expect(loaded.position.set).toHaveBeenCalledWith(48 + 0.1 * 96, 48 - 0.1 * 96)
  })

  it("re-fits live when the transform prop changes (no model rebuild)", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    const view = renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    const initCalls = loadLive2dSkinAsset.mock.calls.length
    loaded.scale.set.mockClear()
    view.rerender(
      <Live2dCanvas
        modelId="m1"
        bones={bones}
        stage={stage}
        state="idle"
        oneShot={null}
        reducedMotion={false}
        size={96}
        transform={{ scale: 2, offsetX: 0, offsetY: 0 }}
      />
    )
    await waitFor(() =>
      expect(loaded.scale.set).toHaveBeenCalledWith((96 / 400) * 2, (96 / 400) * 2)
    )
    // The heavy init effect did not re-run.
    expect(loadLive2dSkinAsset.mock.calls.length).toBe(initCalls)
  })

  it("extracts motion-group counts from the stored settings and feeds random overrides", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    loadLive2dSkinAsset.mockResolvedValue({
      row: { ...row, motionGroups: ["Idle"] },
      entries: [
        {
          path: "Hiyori.model3.json",
          blob: new Blob([
            JSON.stringify({
              FileReferences: {
                Moc: "a.moc3",
                Motions: { Idle: [{ File: "a" }, { File: "b" }, { File: "c" }, { File: "d" }] },
              },
            }),
          ]),
        },
      ],
    })
    const rng = jest.spyOn(Math, "random").mockReturnValue(0.6)
    try {
      renderCanvas({ motionOverrides: { idle: { motionGroup: "Idle" } } })
      // 0.6 * 4 motions → index 2, idle priority (1).
      await waitFor(() => expect(loaded.motion).toHaveBeenCalledWith("Idle", 2, 1))
    } finally {
      rng.mockRestore()
    }
  })

  it("stops the ticker when paused (hidden window)", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas({ paused: true })
    await waitFor(() => expect(tickerStop).toHaveBeenCalled())
  })

  it("initializes high-DPI aware with antialias on and a 60fps cap by default", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas()
    // The FPS effect lands once the model state commits — wait for the value.
    await waitFor(() => expect(tickerState.maxFPS).toBe(60))
    expect(appInit).toHaveBeenCalledWith(
      expect.objectContaining({
        antialias: true,
        autoDensity: true,
        resolution: 1,
        powerPreference: "high-performance",
      })
    )
  })

  it("caps the render resolution at 2x on high-DPI displays", async () => {
    const original = window.devicePixelRatio
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true })
    try {
      load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
      renderCanvas()
      await waitFor(() =>
        expect(appInit).toHaveBeenCalledWith(expect.objectContaining({ resolution: 2 }))
      )
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: original, configurable: true })
    }
  })

  it("low-power mode disables antialias at init and caps the ticker at 30fps", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas({ lowPower: true })
    await waitFor(() => expect(tickerState.maxFPS).toBe(30))
    expect(appInit).toHaveBeenCalledWith(
      expect.objectContaining({ antialias: false, powerPreference: "low-power" })
    )
  })

  it("loads the model on the app ticker with pointer tracking off and texture LOD on", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas()
    await waitFor(() => expect(load).toHaveBeenCalled())
    const args = load.mock.calls[0][0] as { modelOptions: Record<string, unknown> }
    expect(args.modelOptions).toMatchObject({
      // The app ticker (not Ticker.shared) must drive the Cubism update so
      // paused / low-power ticker controls govern the CPU work too.
      ticker: tickerState,
      autoHitTest: false,
      autoFocus: false,
      textureOptions: { lod: "single-auto", lodTextureSizeThreshold: 1024 },
    })
    // High-precision masks stay on 'auto' (engine default) outside low power.
    expect(args.modelOptions).not.toHaveProperty("useHighPrecisionMask")
  })

  it("low-power mode additionally forces low-precision masks", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas({ lowPower: true })
    await waitFor(() => expect(load).toHaveBeenCalled())
    const args = load.mock.calls[0][0] as { modelOptions: Record<string, unknown> }
    expect(args.modelOptions).toMatchObject({ useHighPrecisionMask: false })
  })

  it("tolerates a loaded model that lacks anchor/position/scale setters", async () => {
    const loaded = {
      width: 100,
      height: 100,
      motion: jest.fn(),
      expression: jest.fn(),
      internalModel: { motionManager: { stopAllMotions: jest.fn() } },
    }
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalledWith(loaded))
  })

  it("renders a canvas with the live2d skin root marker", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    const { container } = renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    expect(container.querySelector('[data-pet-skin-root="live2d"]')).not.toBeNull()
  })

  it("reports onError and adds nothing when the loader fails", async () => {
    const onError = jest.fn()
    load.mockResolvedValue({ ok: false, code: "coreMissing" })
    renderCanvas({ onError })
    await waitFor(() => expect(onError).toHaveBeenCalledWith("coreMissing"))
    expect(addChild).not.toHaveBeenCalled()
  })

  it("reports modelMissing when the row is absent", async () => {
    const onError = jest.fn()
    loadLive2dSkinAsset.mockResolvedValue(undefined)
    renderCanvas({ onError })
    await waitFor(() => expect(onError).toHaveBeenCalledWith("modelMissing"))
  })

  it("reports modelFailed when init throws", async () => {
    const onError = jest.fn()
    appInit.mockRejectedValueOnce(new Error("webgl"))
    renderCanvas({ onError })
    await waitFor(() => expect(onError).toHaveBeenCalledWith("modelFailed"))
  })

  it("guards the render loop: removes pixi's default auto-render and adds its own", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    // pixi auto-renders via ticker.add(app.render, app); the canvas swaps that
    // for a guarded listener so a render-loop throw can't escape uncaught. The
    // listener re-registers at LOW priority (-25) so it still runs AFTER the
    // model's ticker update (added at NORMAL by the engine's Automator).
    expect(tickerRemove).toHaveBeenCalledWith(appRender, expect.anything())
    expect(tickerAdd).toHaveBeenCalledWith(expect.any(Function), undefined, -25)
    // The guarded listener drives a normal frame through app.render().
    runGuardedRender()
    expect(appRender).toHaveBeenCalled()
  })

  it("degrades to the SVG skin when the render loop throws (texture.source null)", async () => {
    const onError = jest.fn()
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    renderCanvas({ onError })
    await waitFor(() => expect(tickerAdd).toHaveBeenCalled())
    // A texture whose GPU source was invalidated (WebGL context loss) throws
    // mid-frame inside the engine's renderLive2D — surfaced here via app.render.
    appRender.mockImplementationOnce(() => {
      throw new TypeError("null is not an object (evaluating 'texture.source')")
    })
    act(() => runGuardedRender())
    // The crash loop is halted and the typed code degrades to the SVG skin.
    expect(tickerStop).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith("renderFailed")
  })

  it("disposes the model and destroys the app on unmount", async () => {
    const dispose = jest.fn()
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose })
    const view = renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    act(() => view.unmount())
    expect(dispose).toHaveBeenCalled()
    expect(appDestroy).toHaveBeenCalledWith(true, { children: true })
  })

  it("resizes the renderer and re-fits when size changes", async () => {
    const loaded = makeLoadedModel()
    load.mockResolvedValue({ ok: true, model: loaded, dispose: jest.fn() })
    const view = renderCanvas({ size: 96 })
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    resize.mockClear()
    view.rerender(
      <Live2dCanvas
        modelId="m1"
        bones={bones}
        stage={stage}
        state="idle"
        oneShot={null}
        reducedMotion={false}
        size={120}
      />
    )
    await waitFor(() => expect(resize).toHaveBeenCalledWith(120, 120))
  })

  it("stops the ticker when reduced motion is on", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas({ reducedMotion: true })
    await waitFor(() => expect(tickerStop).toHaveBeenCalled())
  })

  it("swallows dispose/destroy errors on unmount", async () => {
    const dispose = jest.fn(() => {
      throw new Error("dispose boom")
    })
    appDestroy.mockImplementation(() => {
      throw new Error("destroy boom")
    })
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose })
    const view = renderCanvas()
    await waitFor(() => expect(addChild).toHaveBeenCalled())
    expect(() => act(() => view.unmount())).not.toThrow()
    expect(dispose).toHaveBeenCalled()
  })

  it("bails out cleanly when unmounted while the row fetch is in flight", async () => {
    let resolveAsset: (v: unknown) => void = () => {}
    loadLive2dSkinAsset.mockReturnValue(new Promise((r) => (resolveAsset = r)))
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    const view = renderCanvas()
    await waitFor(() => expect(loadLive2dSkinAsset).toHaveBeenCalled())
    act(() => view.unmount())
    await act(async () => {
      resolveAsset({ row, entries: [{ path: "Hiyori.model3.json", blob: new Blob(["{}"]) }] })
      await Promise.resolve()
    })
    // Cancelled after the row resolved → pixi init never runs.
    expect(appInit).not.toHaveBeenCalled()
    expect(addChild).not.toHaveBeenCalled()
  })

  it("bails out cleanly when unmounted while pixi is initializing", async () => {
    let resolveInit: () => void = () => {}
    appInit.mockReturnValue(new Promise<void>((r) => (resolveInit = r)))
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    const view = renderCanvas()
    await waitFor(() => expect(appInit).toHaveBeenCalled())
    act(() => view.unmount())
    await act(async () => {
      resolveInit()
      await Promise.resolve()
    })
    expect(addChild).not.toHaveBeenCalled()
  })

  it("disposes a model that finished loading after the component was cancelled", async () => {
    const dispose = jest.fn()
    let resolveLoad: (v: unknown) => void = () => {}
    load.mockReturnValue(new Promise((r) => (resolveLoad = r)))
    const view = renderCanvas()
    await waitFor(() => expect(load).toHaveBeenCalled())
    act(() => view.unmount())
    await act(async () => {
      resolveLoad({ ok: true, model: makeLoadedModel(), dispose })
      await Promise.resolve()
    })
    expect(dispose).toHaveBeenCalled()
    expect(addChild).not.toHaveBeenCalled()
  })
})
