import { render, waitFor, act } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { addPetModel, updatePetModelCustomization } from "@/lib/db/pet-models"
import { resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import { generateBones } from "@/lib/pet/bones/generate"

// Keep Dexie, its live query and asset loading real; only replace the GPU runtime.
jest.mock("pixi.js", () => {
  const app = {
    stage: { addChild: jest.fn() },
    renderer: { resize: jest.fn() },
    ticker: { start: jest.fn(), stop: jest.fn(), add: jest.fn(), remove: jest.fn() },
    init: jest.fn(async () => {}),
    render: jest.fn(),
    destroy: jest.fn(),
  }
  return { Application: jest.fn(() => app) }
})
jest.mock("@/lib/pet/live2d/register-plugin", () => ({
  ensureLive2dPluginRegistered: jest.fn(async () => {}),
}))
jest.mock("@/lib/pet/live2d/loader", () => ({
  createLive2dLoader: jest.fn(),
}))

import { Application } from "pixi.js"
import { createLive2dLoader } from "@/lib/pet/live2d/loader"
import Live2dCanvas from "./live2d-canvas"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  resetPetSkinRuntimeForTests()
  jest.clearAllMocks()
  jest.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,")
})
afterEach(() => jest.restoreAllMocks())
afterAll(fixture.dispose)

it("updates the mounted canvas after a real Dexie save without a rerender or model reload", async () => {
  const model = {
    width: 200,
    height: 400,
    anchor: { set: jest.fn() },
    position: { set: jest.fn() },
    scale: { set: jest.fn() },
    motion: jest.fn(),
    expression: jest.fn(),
    internalModel: {
      on: jest.fn(),
      off: jest.fn(),
      coreModel: { setParameterValueById: jest.fn() },
    },
  }
  const load = jest.fn(async () => ({ ok: true as const, model, dispose: jest.fn() }))
  jest.mocked(createLive2dLoader).mockReturnValue({ load })
  const row = await addPetModel(
    {
      name: "Persistence fixture",
      source: "import",
      settingsPath: "fixture.model3.json",
      motionGroups: ["Idle", "TapBody"],
      expressionIds: [],
      totalBytes: 0,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
      compatibility: {
        version: 1,
        status: "ready",
        diagnostics: [],
        usableMotionGroups: ["Idle", "TapBody"],
        usableExpressionIds: [],
        usableParameterIds: [],
        resourceCost: { totalBytes: 0, fileCount: 0, textureBytes: 0 },
      },
    },
    []
  )
  render(
    <Live2dCanvas
      modelId={row.id}
      bones={generateBones("persistence-regression")}
      stage="adult"
      state="idle"
      oneShot={null}
      reducedMotion={false}
      size={100}
      speaking
    />
  )
  await waitFor(() => expect(model.motion).toHaveBeenCalledWith("Idle", 0, 1))
  expect(model.internalModel.on).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function))

  await act(async () => {
    await updatePetModelCustomization(row.id, {
      transform: { scale: 1.5, offsetX: 0.1, offsetY: -0.1 },
      motionOverrides: { idle: { motionGroup: "TapBody" } },
      parameterMapping: { mouthOpen: null },
    })
  })
  await waitFor(() => expect(model.scale.set).toHaveBeenLastCalledWith(0.375, 0.375))
  expect(model.position.set).toHaveBeenLastCalledWith(60, 40)
  expect(model.motion).toHaveBeenLastCalledWith("TapBody", 0, 1)
  expect(model.internalModel.off).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function))

  await act(async () => {
    await updatePetModelCustomization(row.id, {
      transform: undefined,
      motionOverrides: {},
      parameterMapping: {},
    })
  })
  await waitFor(() => expect(model.scale.set).toHaveBeenLastCalledWith(0.25, 0.25))
  expect(model.position.set).toHaveBeenLastCalledWith(50, 50)
  expect(model.motion).toHaveBeenLastCalledWith("Idle", 0, 1)
  expect(model.internalModel.on).toHaveBeenCalledTimes(2)
  expect(load).toHaveBeenCalledTimes(1)
  expect(Application).toHaveBeenCalledTimes(1)
})
