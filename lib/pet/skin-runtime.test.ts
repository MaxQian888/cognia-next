/** @jest-environment jsdom */

import { getPetSkinRuntime, PetSkinRuntime, resetPetSkinRuntimeForTests } from "./skin-runtime"

describe("PetSkinRuntime", () => {
  it("grants one live lease using the documented priority order", () => {
    const runtime = new PetSkinRuntime()
    const card = runtime.acquireLease("card", "thumbnail")
    const hero = runtime.acquireLease("hero", "console")
    const widget = runtime.acquireLease("widget", "interactive")
    const editor = runtime.acquireLease("editor", "configuration")

    expect(card.mode()).toBe("placeholder")
    expect(hero.mode()).toBe("placeholder")
    expect(widget.mode()).toBe("placeholder")
    expect(editor.mode()).toBe("live")
    expect(runtime.diagnostics().activeLiveRenderers).toBe(1)

    editor.release()
    expect(widget.mode()).toBe("live")
    expect(runtime.diagnostics().activeLiveRenderers).toBe(1)
  })

  it("uses a neutral snapshot for non-owning previews when one exists", () => {
    const runtime = new PetSkinRuntime()
    runtime.publishSnapshot("live2d:m1", "data:image/png;base64,abc")
    runtime.acquireLease("widget", "interactive")
    const preview = runtime.acquireLease("card", "thumbnail", "live2d:m1")
    expect(preview.mode()).toBe("snapshot")
    expect(preview.snapshot()).toBe("data:image/png;base64,abc")
  })

  it("caches one object URL per asset and revokes it on invalidation", () => {
    const createObjectURL = jest.fn(() => "blob:atlas")
    const revokeObjectURL = jest.fn()
    const runtime = new PetSkinRuntime({ createObjectURL, revokeObjectURL })
    const blob = new Blob(["atlas"])

    expect(runtime.objectUrl("sprite:momo", blob)).toBe("blob:atlas")
    expect(runtime.objectUrl("sprite:momo", blob)).toBe("blob:atlas")
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(runtime.diagnostics()).toMatchObject({ objectUrls: 1, assetLoads: 1 })

    runtime.invalidateAsset("sprite:momo")
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:atlas")
    expect(runtime.diagnostics().objectUrls).toBe(0)
  })

  it("invalidates a switched asset after its final renderer lease releases", () => {
    const revokeObjectURL = jest.fn()
    const runtime = new PetSkinRuntime({
      createObjectURL: () => "blob:atlas",
      revokeObjectURL,
    })
    const first = runtime.acquireLease("widget", "interactive", "sprite-v2:momo")
    const preview = runtime.acquireLease("preview", "thumbnail", "sprite-v2:momo")
    runtime.objectUrl("sprite-v2:momo", new Blob(["atlas"]))

    first.release()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    preview.release()

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:atlas")
    expect(runtime.diagnostics()).toMatchObject({ activeLiveRenderers: 0, objectUrls: 0 })
  })

  it("owns frame URLs under their pack and releases them together", () => {
    const createObjectURL = jest
      .fn()
      .mockReturnValueOnce("blob:a")
      .mockReturnValueOnce("blob:b")
      .mockReturnValueOnce("blob:other")
    const revokeObjectURL = jest.fn()
    const runtime = new PetSkinRuntime({ createObjectURL, revokeObjectURL })
    const blob = new Blob(["frame"])
    expect(runtime.objectUrl("media:mp_whale", blob, "a.webp")).toBe("blob:a")
    expect(runtime.objectUrl("media:mp_whale", blob, "a.webp")).toBe("blob:a")
    expect(runtime.objectUrl("media:mp_whale", blob, "b.webp")).toBe("blob:b")
    runtime.objectUrl("media:mp_other", blob, "a.webp")
    runtime.invalidateAsset("media:mp_whale")
    expect(revokeObjectURL.mock.calls).toEqual([["blob:a"], ["blob:b"]])
    expect(runtime.diagnostics().objectUrls).toBe(1)
  })

  it("permits one automatic context recovery before degrading", () => {
    const runtime = new PetSkinRuntime()
    expect(runtime.recordContextLoss("live2d:m1")).toEqual({ action: "retry", delayMs: 250 })
    expect(runtime.recordContextLoss("live2d:m1")).toEqual({ action: "degraded" })
    expect(runtime.assetDiagnostic("live2d:m1")).toMatchObject({
      code: "contextLost",
      severity: "error",
      recoverable: true,
    })
    expect(runtime.diagnostics()).toMatchObject({ contextLosses: 2, fallbacks: 1 })
    const retryGeneration = runtime.retryGeneration("live2d:m1")
    runtime.retryAsset("live2d:m1")
    expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()
    expect(runtime.retryGeneration("live2d:m1")).toBe(retryGeneration + 1)
    expect(runtime.recordContextLoss("live2d:m1")).toEqual({ action: "retry", delayMs: 250 })
  })

  it("publishes load and render failures as actionable asset diagnostics", () => {
    const runtime = new PetSkinRuntime()
    runtime.recordAssetFailure("live2d:m1", "renderFailed")
    expect(runtime.assetDiagnostic("live2d:m1")).toMatchObject({
      code: "renderFailed",
      detail: "renderFailed",
      recoverable: true,
    })
    runtime.retryAsset("live2d:m1")
    expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()

    runtime.recordAssetFailure("live2d:m1", "coreMissing")
    expect(runtime.assetDiagnostic("live2d:m1")?.code).toBe("runtimeUnavailable")
  })

  it("drops cached load state and object URLs before retrying an asset", async () => {
    const revokeObjectURL = jest.fn()
    const runtime = new PetSkinRuntime({
      createObjectURL: () => "blob:atlas",
      revokeObjectURL,
    })
    const loader = jest.fn().mockResolvedValue({ id: "momo" })

    await runtime.loadAsset("sprite-v2:momo", loader)
    runtime.objectUrl("sprite-v2:momo", new Blob(["atlas"]))
    runtime.retryAsset("sprite-v2:momo")
    await runtime.loadAsset("sprite-v2:momo", loader)

    expect(loader).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:atlas")
  })

  it("retries missing assets instead of retaining a fulfilled absent value", async () => {
    const runtime = new PetSkinRuntime()
    const load = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("ready")
    expect(await runtime.loadAsset("live2d:m1", load)).toBeUndefined()
    expect(await runtime.loadAsset("live2d:m1", load)).toBe("ready")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each(["missing", "rejected"])(
    "does not evict replacement bytes when a superseded load is %s",
    async (outcome) => {
      const runtime = new PetSkinRuntime()
      let resolve!: (value: undefined) => void, reject!: (error: Error) => void
      const old = runtime.loadAsset(
        "live2d:m1",
        () =>
          new Promise<undefined>((yes, no) => {
            resolve = yes
            reject = no
          })
      )
      const settled = old.catch(() => undefined)
      runtime.retryAsset("live2d:m1")
      const fresh = jest.fn(async () => "new-account-blob")
      await runtime.loadAsset("live2d:m1", fresh)
      if (outcome === "missing") resolve(undefined)
      else reject(new Error("old request failed"))
      await settled
      expect(await runtime.loadAsset("live2d:m1", fresh)).toBe("new-account-blob")
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(runtime.retryGeneration("live2d:m1")).toBe(1)
    }
  )

  it("returns every active resource counter to baseline after repeated cycles", () => {
    const runtime = new PetSkinRuntime({
      createObjectURL: (_blob) => `blob:${Math.random()}`,
      revokeObjectURL: () => {},
    })
    for (let index = 0; index < 20; index += 1) {
      const lease = runtime.acquireLease(`owner-${index}`, "interactive")
      const ticker = runtime.track("tickers")
      const timer = runtime.track("timers")
      const context = runtime.track("webglContexts")
      runtime.objectUrl(`sprite:${index}`, new Blob([String(index)]))
      ticker()
      timer()
      context()
      lease.release()
      runtime.invalidateAsset(`sprite:${index}`)
    }
    expect(runtime.diagnostics()).toMatchObject({
      activeLiveRenderers: 0,
      webglContexts: 0,
      tickers: 0,
      timers: 0,
      objectUrls: 0,
    })
  })

  it("destroys cached WebView resources on pagehide", () => {
    resetPetSkinRuntimeForTests()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const createObjectURL = jest.fn(() => "blob:cached")
    const revokeObjectURL = jest.fn()
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
    try {
      const runtime = getPetSkinRuntime()
      runtime.objectUrl("sprite-v2:momo", new Blob(["atlas"]))
      const releaseTimer = runtime.track("timers")
      window.dispatchEvent(new Event("pagehide"))

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:cached")
      expect(runtime.diagnostics()).toEqual({
        activeLiveRenderers: 0,
        webglContexts: 0,
        tickers: 0,
        timers: 0,
        objectUrls: 0,
        assetLoads: 0,
        contextLosses: 0,
        fallbacks: 0,
      })
      expect(getPetSkinRuntime()).not.toBe(runtime)
      releaseTimer()
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate })
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke })
      resetPetSkinRuntimeForTests()
    }
  })
})
