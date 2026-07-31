/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import { useLive2dParamEmotion, type Live2dParamEmotionModel } from "./use-live2d-param-emotion"

function makeModel() {
  const handlers = new Map<string, Set<() => void>>()
  const writes: Array<{ id: string; value: number }> = []
  const model: Live2dParamEmotionModel = {
    internalModel: {
      on: (event: string, handler: () => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set())
        handlers.get(event)!.add(handler)
      },
      off: (event: string, handler: () => void) => {
        handlers.get(event)?.delete(handler)
      },
      coreModel: {
        setParameterValueById: (id: string, value: number) => {
          writes.push({ id, value })
        },
      },
    },
  }
  const fire = () => {
    for (const h of handlers.get("beforeModelUpdate") ?? []) h()
  }
  const handlerCount = () => handlers.get("beforeModelUpdate")?.size ?? 0
  return { model, writes, fire, handlerCount }
}

describe("useLive2dParamEmotion", () => {
  it("writes envelope parameters each frame while thinking", () => {
    const { model, writes, fire } = makeModel()
    let t = 0
    renderHook(() => useLive2dParamEmotion(model, "thinking", null, false, () => (t += 250)))
    fire()
    fire()
    expect(writes.length).toBeGreaterThanOrEqual(4)
    expect(writes.some((w) => w.id === "ParamAngleZ")).toBe(true)
    expect(writes.some((w) => w.id === "ParamEyeBallX")).toBe(true)
  })

  it("registers nothing for uncovered states, one-shots, or reduced motion", () => {
    const idle = makeModel()
    renderHook(() => useLive2dParamEmotion(idle.model, "idle", null, false))
    expect(idle.handlerCount()).toBe(0)

    const shot = makeModel()
    renderHook(() => useLive2dParamEmotion(shot.model, "thinking", "wave", false))
    expect(shot.handlerCount()).toBe(0)

    const reduced = makeModel()
    renderHook(() => useLive2dParamEmotion(reduced.model, "thinking", null, true))
    expect(reduced.handlerCount()).toBe(0)
  })

  it("unregisters the frame handler on unmount and state exit", () => {
    const { model, handlerCount } = makeModel()
    const { rerender, unmount } = renderHook(
      ({ state }: { state: "thinking" | "happy" }) =>
        useLive2dParamEmotion(model, state, null, false),
      { initialProps: { state: "thinking" as "thinking" | "happy" } }
    )
    expect(handlerCount()).toBe(1)
    rerender({ state: "happy" })
    expect(handlerCount()).toBe(0)
    rerender({ state: "thinking" })
    expect(handlerCount()).toBe(1)
    unmount()
    expect(handlerCount()).toBe(0)
  })

  it("tolerates models without the event surface", () => {
    const bare: Live2dParamEmotionModel = { internalModel: {} }
    expect(() =>
      renderHook(() => useLive2dParamEmotion(bare, "thinking", null, false))
    ).not.toThrow()
  })

  it("swallows parameter-write throws", () => {
    const { model, fire } = makeModel()
    model.internalModel!.coreModel!.setParameterValueById = () => {
      throw new Error("boom")
    }
    renderHook(() => useLive2dParamEmotion(model, "review", null, false))
    expect(() => fire()).not.toThrow()
  })
})
