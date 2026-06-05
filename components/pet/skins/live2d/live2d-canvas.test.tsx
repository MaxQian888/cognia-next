import { render, waitFor, act } from "@testing-library/react"
import type { PetBones, PetStage } from "@/types/pet"

// pixi.js and the engine loader are WebGL/Cubism runtimes jsdom can't host.
// Mock the loader module and the DB; pixi.js is mocked inline with shared
// jest.fn handles so each lifecycle call can be asserted directly.
const addChild = jest.fn()
const resize = jest.fn()
const tickerStop = jest.fn()
const tickerStart = jest.fn()
const appDestroy = jest.fn()
const appInit = jest.fn(() => Promise.resolve())

const tickerState: { maxFPS?: number } = {}
jest.mock("pixi.js", () => ({
  Application: class {
    stage = { addChild }
    renderer = { resize }
    ticker = Object.assign(tickerState, { stop: tickerStop, start: tickerStart })
    init = appInit
    destroy = appDestroy
  },
}))

const load = jest.fn()
jest.mock("@/lib/pet/live2d/loader", () => ({
  createLive2dLoader: () => ({ load }),
}))

const getPetModel = jest.fn()
const getPetModelEntries = jest.fn()
jest.mock("@/lib/db/pet-models", () => ({
  getPetModel: (...a: unknown[]) => getPetModel(...a),
  getPetModelEntries: (...a: unknown[]) => getPetModelEntries(...a),
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
    internalModel: { motionManager: { stopAllMotions: jest.fn() } },
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
  getPetModel.mockResolvedValue(row)
  getPetModelEntries.mockResolvedValue([{ path: "Hiyori.model3.json", blob: new Blob(["{}"]) }])
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
    // fitModel centers + scales the model (after a reset-to-1 measurement pass).
    expect(loaded.anchor.set).toHaveBeenCalledWith(0.5, 0.5)
    expect(loaded.position.set).toHaveBeenCalledWith(48, 48)
    expect(loaded.scale.set).toHaveBeenCalledWith(96 / 400, 96 / 400)
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
      expect.objectContaining({ antialias: true, autoDensity: true, resolution: 1 })
    )
  })

  it("low-power mode disables antialias at init and caps the ticker at 30fps", async () => {
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    renderCanvas({ lowPower: true })
    await waitFor(() => expect(tickerState.maxFPS).toBe(30))
    expect(appInit).toHaveBeenCalledWith(expect.objectContaining({ antialias: false }))
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
    getPetModel.mockResolvedValue(undefined)
    renderCanvas({ onError })
    await waitFor(() => expect(onError).toHaveBeenCalledWith("modelMissing"))
  })

  it("reports modelFailed when init throws", async () => {
    const onError = jest.fn()
    appInit.mockRejectedValueOnce(new Error("webgl"))
    renderCanvas({ onError })
    await waitFor(() => expect(onError).toHaveBeenCalledWith("modelFailed"))
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
    let resolveRow: (v: unknown) => void = () => {}
    getPetModel.mockReturnValue(new Promise((r) => (resolveRow = r)))
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    const view = renderCanvas()
    await waitFor(() => expect(getPetModel).toHaveBeenCalled())
    act(() => view.unmount())
    await act(async () => {
      resolveRow(row)
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

  it("bails out cleanly when unmounted while loading the model entries", async () => {
    let resolveEntries: (v: unknown) => void = () => {}
    getPetModelEntries.mockReturnValue(new Promise((r) => (resolveEntries = r)))
    load.mockResolvedValue({ ok: true, model: makeLoadedModel(), dispose: jest.fn() })
    const view = renderCanvas()
    await waitFor(() => expect(getPetModelEntries).toHaveBeenCalled())
    act(() => view.unmount())
    await act(async () => {
      resolveEntries([{ path: "Hiyori.model3.json", blob: new Blob(["{}"]) }])
      await Promise.resolve()
    })
    expect(load).not.toHaveBeenCalled()
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
