import {
  CUBISM_CORE_PUBLIC_PATH,
  CUBISM_CORE_URL,
  MAX_MODEL_BYTES,
  SAMPLE_MODEL_CATALOG,
} from "./constants"

describe("live2d constants", () => {
  it("points the core URL at the official Live2D CDN", () => {
    expect(CUBISM_CORE_URL).toBe(
      "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
    )
  })

  it("serves the core from a local public path under /live2d/", () => {
    expect(CUBISM_CORE_PUBLIC_PATH).toBe("/live2d/live2dcubismcore.min.js")
    expect(CUBISM_CORE_PUBLIC_PATH.startsWith("/live2d/")).toBe(true)
  })

  it("caps a single model bundle at 50 MB", () => {
    expect(MAX_MODEL_BYTES).toBe(50 * 1024 * 1024)
  })

  it("seeds Hiyori and Haru with consistent URL shapes", () => {
    const ids = SAMPLE_MODEL_CATALOG.map((m) => m.id)
    expect(ids).toEqual(["hiyori", "haru"])

    for (const model of SAMPLE_MODEL_CATALOG) {
      expect(model.baseUrl).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/Live2D\/CubismWebSamples\/develop\/Samples\/Resources\/.+\/$/
      )
      // The settings file is listed among the files to download.
      expect(model.files).toContain(model.settingsFile)
      // Every settings file is a modern model3.json.
      expect(model.settingsFile.endsWith(".model3.json")).toBe(true)
      // A moc3 and at least one texture are present.
      expect(model.files.some((f) => f.endsWith(".moc3"))).toBe(true)
      expect(model.files.some((f) => f.endsWith(".png"))).toBe(true)
    }
  })

  it("has no duplicate file references", () => {
    for (const model of SAMPLE_MODEL_CATALOG) {
      expect(new Set(model.files).size).toBe(model.files.length)
    }
  })

  // Regression guard for the "motion 404 at play time" bug: a sample's `files`
  // must list EVERY asset the model3.json references, not just moc/textures.
  // Motions/expressions/sounds load lazily, so an incomplete list passes import
  // validation but 404s from the web root when a state plays the missing motion.
  // These sets are the verified FileReferences of each upstream model3.json.
  it("downloads every motion Hiyori's model3.json references", () => {
    const hiyori = SAMPLE_MODEL_CATALOG.find((m) => m.id === "hiyori")!
    const expectedMotions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
      (n) => `motions/Hiyori_m${String(n).padStart(2, "0")}.motion3.json`
    )
    for (const motion of expectedMotions) {
      expect(hiyori.files).toContain(motion)
    }
  })

  it("downloads every motion, expression, and motion sound Haru's model3.json references", () => {
    const haru = SAMPLE_MODEL_CATALOG.find((m) => m.id === "haru")!
    const expected = [
      // Expressions F01-F08.
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `expressions/F0${n}.exp3.json`),
      // Idle + TapBody motions.
      "motions/haru_g_idle.motion3.json",
      "motions/haru_g_m15.motion3.json",
      "motions/haru_g_m26.motion3.json",
      "motions/haru_g_m06.motion3.json",
      "motions/haru_g_m20.motion3.json",
      "motions/haru_g_m09.motion3.json",
      // Sounds referenced by the TapBody motions.
      "sounds/haru_talk_13.wav",
      "sounds/haru_Info_14.wav",
      "sounds/haru_normal_6.wav",
      "sounds/haru_Info_04.wav",
    ]
    for (const file of expected) {
      expect(haru.files).toContain(file)
    }
    // The old catalog listed a non-existent motion that 404'd the import.
    expect(haru.files).not.toContain("motions/haru_g_m01.motion3.json")
  })
})
