import { readLive2dParameterIds, resolveLive2dParameterMapping } from "./parameter-mapping"

it("auto-detects standard Cubism head, eye, body and mouth parameters", () => {
  expect(
    resolveLive2dParameterMapping([
      "ParamAngleX",
      "ParamAngleY",
      "ParamAngleZ",
      "ParamEyeBallX",
      "ParamEyeBallY",
      "ParamBodyAngleX",
      "ParamBodyAngleY",
      "ParamMouthOpenY",
    ])
  ).toEqual({
    headX: "ParamAngleX",
    headY: "ParamAngleY",
    headZ: "ParamAngleZ",
    eyeX: "ParamEyeBallX",
    eyeY: "ParamEyeBallY",
    bodyX: "ParamBodyAngleX",
    bodyY: "ParamBodyAngleY",
    mouthOpen: "ParamMouthOpenY",
  })
})

it("reads runtime parameter ids without depending on Cubism classes", () => {
  expect(
    readLive2dParameterIds({
      getParameterCount: () => 2,
      getParameterId: (index) => ({ getString: () => (index === 0 ? "ParamAngleX" : "Custom") }),
    })
  ).toEqual(["ParamAngleX", "Custom"])
})

it("allows per-model overrides and explicit disabling", () => {
  expect(
    resolveLive2dParameterMapping(["HeadHorizontal", "ParamEyeBallX"], {
      headX: "HeadHorizontal",
      eyeX: null,
    })
  ).toEqual({ headX: "HeadHorizontal" })
})
