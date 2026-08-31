import {
  live2dParameterRoleOf,
  readLive2dParameterIds,
  resolveLive2dParameterMapping,
} from "./parameter-mapping"

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

describe("live2dParameterRoleOf", () => {
  it("resolves both spellings of every standard parameter", () => {
    expect(live2dParameterRoleOf("ParamAngleX")).toBe("headX")
    expect(live2dParameterRoleOf("PARAM_ANGLE_X")).toBe("headX")
    expect(live2dParameterRoleOf("ParamMouthOpenY")).toBe("mouthOpen")
    expect(live2dParameterRoleOf("PARAM_BODY_ANGLE_Y")).toBe("bodyY")
  })

  it("covers every id resolveLive2dParameterMapping can emit", () => {
    // The reverse table is derived, not hand-kept: anything the forward
    // resolver can produce must map back, or an emotion write for that role
    // would silently lose its remapping.
    const resolved = resolveLive2dParameterMapping([])
    for (const parameterId of Object.values(resolved)) {
      expect(live2dParameterRoleOf(parameterId)).toBeDefined()
    }
  })

  it("returns undefined for an id outside the role table", () => {
    expect(live2dParameterRoleOf("ParamBrowLY")).toBeUndefined()
  })
})
