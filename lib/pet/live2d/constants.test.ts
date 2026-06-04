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
})
