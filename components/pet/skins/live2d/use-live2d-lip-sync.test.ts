import { renderHook } from "@testing-library/react"
import { useLive2dLipSync, type Live2dLipSyncModel } from "./use-live2d-lip-sync"
import { LIP_SYNC_PARAM } from "@/lib/pet/live2d/lip-sync"

function makeModel() {
  const setParameterValueById = jest.fn()
  const handlers: Record<string, () => void> = {}
  const on = jest.fn((event: string, handler: () => void) => {
    handlers[event] = handler
  })
  const off = jest.fn((event: string) => {
    delete handlers[event]
  })
  const model: Live2dLipSyncModel = {
    internalModel: { on, off, coreModel: { setParameterValueById } },
  }
  return { model, setParameterValueById, on, off, handlers }
}

describe("useLive2dLipSync", () => {
  it("registers a frame handler while speaking and drives the mouth parameter", () => {
    const { model, setParameterValueById, on, handlers } = makeModel()
    let clock = 1000
    renderHook(() => useLive2dLipSync(model, true, false, () => clock))

    expect(on).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function))

    // Advance the clock and fire two frames — the mouth value must be in range.
    clock = 1080
    handlers.beforeModelUpdate()
    clock = 1160
    handlers.beforeModelUpdate()

    expect(setParameterValueById).toHaveBeenCalledWith(LIP_SYNC_PARAM, expect.any(Number))
    for (const call of setParameterValueById.mock.calls) {
      expect(call[1]).toBeGreaterThanOrEqual(0)
      expect(call[1]).toBeLessThanOrEqual(1)
    }
  })

  it("closes the mouth and unregisters when speaking stops", () => {
    const { model, setParameterValueById, off } = makeModel()
    const { rerender } = renderHook(({ speaking }) => useLive2dLipSync(model, speaking, false), {
      initialProps: { speaking: true },
    })
    setParameterValueById.mockClear()

    rerender({ speaking: false })
    expect(off).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function))
    expect(setParameterValueById).toHaveBeenLastCalledWith(LIP_SYNC_PARAM, 0)
  })

  it("does nothing under reduced motion", () => {
    const { model, on } = makeModel()
    renderHook(() => useLive2dLipSync(model, true, true))
    expect(on).not.toHaveBeenCalled()
  })

  it("does nothing when not speaking", () => {
    const { model, on } = makeModel()
    renderHook(() => useLive2dLipSync(model, false, false))
    expect(on).not.toHaveBeenCalled()
  })

  it("is a no-op when the model lacks the engine surface", () => {
    const bare: Live2dLipSyncModel = { internalModel: { motionManager: {} } as never }
    expect(() => renderHook(() => useLive2dLipSync(bare, true, false))).not.toThrow()
  })

  it("never throws when the parameter write fails", () => {
    const { model, handlers } = makeModel()
    model.internalModel!.coreModel!.setParameterValueById = jest.fn(() => {
      throw new Error("boom")
    })
    renderHook(() => useLive2dLipSync(model, true, false))
    expect(() => handlers.beforeModelUpdate()).not.toThrow()
  })
})
