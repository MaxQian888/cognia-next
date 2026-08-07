import { renderHook } from "@testing-library/react"
import type { Live2dGazeModel } from "./use-live2d-gaze"
import { useLive2dGaze } from "./use-live2d-gaze"

function modelHarness() {
  let handler: (() => void) | undefined
  const setParameterValueById = jest.fn()
  const model: Live2dGazeModel = {
    internalModel: {
      on: (_event, next) => {
        handler = next
      },
      off: jest.fn(),
      coreModel: { setParameterValueById },
    },
  }
  return { model, setParameterValueById, tick: () => handler?.() }
}

it("drives detected head, eye and body parameters from normalized gaze", () => {
  const harness = modelHarness()
  renderHook(() =>
    useLive2dGaze(
      harness.model,
      { x: 0.5, y: -0.25, updatedAt: 1, source: "window" },
      { headX: "ParamAngleX", eyeX: "ParamEyeBallX", eyeY: "ParamEyeBallY" },
      true
    )
  )
  harness.tick()
  expect(harness.setParameterValueById).toHaveBeenCalledWith("ParamAngleX", 6)
  expect(harness.setParameterValueById).toHaveBeenCalledWith("ParamEyeBallX", 0.5)
  expect(harness.setParameterValueById).toHaveBeenCalledWith("ParamEyeBallY", 0.25)
})

it("yields completely while a higher-precedence behavior is active", () => {
  const harness = modelHarness()
  renderHook(() =>
    useLive2dGaze(
      harness.model,
      { x: 1, y: 1, updatedAt: 1, source: "window" },
      { headX: "ParamAngleX" },
      false
    )
  )
  harness.tick()
  expect(harness.setParameterValueById).not.toHaveBeenCalled()
})
