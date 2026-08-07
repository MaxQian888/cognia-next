import { toPetAssetDiagnostics } from "./compatibility-diagnostics"

describe("toPetAssetDiagnostics", () => {
  it("preserves exact paths while classifying required and optional resources", () => {
    expect(
      toPetAssetDiagnostics([
        { code: "missingReferenced", severity: "error", path: "textures/main.png" },
        { code: "missingMotion", severity: "warning", path: "motions/wave.motion3.json" },
      ])
    ).toEqual([
      {
        code: "missingRequiredResource",
        severity: "error",
        path: "textures/main.png",
        detail: "missingReferenced",
        recoverable: true,
      },
      {
        code: "missingOptionalResource",
        severity: "warning",
        path: "motions/wave.motion3.json",
        detail: "missingMotion",
        recoverable: true,
      },
    ])
  })

  it.each([
    ["ambiguousPath", "ambiguousPath"],
    ["duplicatePath", "duplicatePath"],
    ["pathTraversal", "pathTraversal"],
    ["corruptTexture", "corruptTexture"],
    ["cubism2Unsupported", "cubism2Unsupported"],
    ["tooLarge", "assetTooLarge"],
    ["invalidJson", "invalidSettings"],
  ] as const)("maps %s to the shared %s diagnostic", (source, expected) => {
    expect(toPetAssetDiagnostics([{ code: source, severity: "error" }])[0]?.code).toBe(expected)
  })
})
