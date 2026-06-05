import { extractMotionGroupCounts, parseLive2dManifest } from "./manifest"

function modernJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: "Hiyori.moc3",
      Textures: ["Hiyori.2048/texture_00.png", "Hiyori.2048/texture_01.png"],
      Physics: "Hiyori.physics3.json",
      Pose: "Hiyori.pose3.json",
      Motions: {
        Idle: [{ File: "motions/idle.motion3.json" }],
        TapBody: [{ File: "motions/tap.motion3.json" }],
      },
      Expressions: [
        { Name: "happy", File: "exp/happy.exp3.json" },
        { Name: "sad", File: "exp/sad.exp3.json" },
      ],
      ...overrides,
    },
  })
}

describe("extractMotionGroupCounts", () => {
  it("counts the motions per group", () => {
    expect(
      extractMotionGroupCounts(
        modernJson({
          Motions: {
            Idle: [{ File: "a" }, { File: "b" }, { File: "c" }],
            TapBody: [{ File: "d" }],
          },
        })
      )
    ).toEqual({ Idle: 3, TapBody: 1 })
  })

  it("treats a non-array group as zero motions", () => {
    expect(extractMotionGroupCounts(modernJson({ Motions: { Idle: "oops" } }))).toEqual({
      Idle: 0,
    })
  })

  it("returns an empty map for invalid or motion-less json", () => {
    expect(extractMotionGroupCounts("not json")).toEqual({})
    expect(extractMotionGroupCounts("42")).toEqual({})
    expect(extractMotionGroupCounts(JSON.stringify({ FileReferences: {} }))).toEqual({})
    expect(extractMotionGroupCounts(JSON.stringify({}))).toEqual({})
  })
})

describe("parseLive2dManifest", () => {
  it("parses a modern model3.json and resolves paths against the settings dir", () => {
    const result = parseLive2dManifest("model/Hiyori.model3.json", modernJson())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const m = result.manifest
    expect(m.kind).toBe("modern")
    expect(m.settingsPath).toBe("model/Hiyori.model3.json")
    expect(m.mocPath).toBe("model/Hiyori.moc3")
    expect(m.texturePaths).toEqual([
      "model/Hiyori.2048/texture_00.png",
      "model/Hiyori.2048/texture_01.png",
    ])
    expect(m.motionGroups).toEqual(["Idle", "TapBody"])
    expect(m.expressionIds).toEqual(["happy", "sad"])
    expect(m.physicsPath).toBe("model/Hiyori.physics3.json")
    expect(m.posePath).toBe("model/Hiyori.pose3.json")
  })

  it("resolves paths with no settings directory (root-level settings)", () => {
    const result = parseLive2dManifest("Hiyori.model3.json", modernJson())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.mocPath).toBe("Hiyori.moc3")
    expect(result.manifest.texturePaths[0]).toBe("Hiyori.2048/texture_00.png")
  })

  it("normalizes ./ and ../ segments in referenced paths", () => {
    const json = JSON.stringify({
      FileReferences: {
        Moc: "./model.moc3",
        Textures: ["../shared/tex.png"],
      },
    })
    const result = parseLive2dManifest("a/b/x.model3.json", json)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.mocPath).toBe("a/b/model.moc3")
    expect(result.manifest.texturePaths).toEqual(["a/shared/tex.png"])
  })

  it("omits physics and pose when absent", () => {
    const json = JSON.stringify({
      FileReferences: { Moc: "m.moc3", Textures: ["t.png"] },
    })
    const result = parseLive2dManifest("m.model3.json", json)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.physicsPath).toBeUndefined()
    expect(result.manifest.posePath).toBeUndefined()
    expect(result.manifest.motionGroups).toEqual([])
    expect(result.manifest.expressionIds).toEqual([])
  })

  it("yields no textures when Textures is absent or not an array", () => {
    const json = JSON.stringify({ FileReferences: { Moc: "m.moc3", Textures: "oops" } })
    const result = parseLive2dManifest("m.model3.json", json)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.texturePaths).toEqual([])
  })

  it("rejects invalid JSON", () => {
    expect(parseLive2dManifest("a.model3.json", "{not json")).toEqual({
      ok: false,
      code: "invalidJson",
    })
  })

  it("rejects JSON that is not an object", () => {
    expect(parseLive2dManifest("a.model3.json", "42")).toEqual({
      ok: false,
      code: "invalidJson",
    })
  })

  it("rejects modern JSON missing FileReferences", () => {
    expect(parseLive2dManifest("a.model3.json", "{}")).toEqual({
      ok: false,
      code: "invalidJson",
    })
  })

  it("rejects modern JSON missing Moc", () => {
    const json = JSON.stringify({ FileReferences: { Textures: ["t.png"] } })
    expect(parseLive2dManifest("a.model3.json", json)).toEqual({
      ok: false,
      code: "invalidJson",
    })
  })

  it("rejects a Cubism 2 file by name (.model.json)", () => {
    const json = JSON.stringify({ FileReferences: { Moc: "m.moc3", Textures: ["t.png"] } })
    expect(parseLive2dManifest("Koharu.model.json", json)).toEqual({
      ok: false,
      code: "cubism2Unsupported",
    })
  })

  it("rejects a Cubism 2 file by legacy shape (top-level model + motions)", () => {
    const json = JSON.stringify({
      model: "model.moc",
      textures: ["t.png"],
      motions: { idle: [{ file: "i.mtn" }] },
    })
    expect(parseLive2dManifest("legacy.json", json)).toEqual({
      ok: false,
      code: "cubism2Unsupported",
    })
  })

  it("treats non-string Textures / Expressions entries tolerantly", () => {
    const json = JSON.stringify({
      FileReferences: {
        Moc: "m.moc3",
        Textures: ["good.png", 42, null],
        Expressions: [{ Name: "ok", File: "e.json" }, { File: "noname.json" }, 7],
        Motions: null,
      },
    })
    const result = parseLive2dManifest("m.model3.json", json)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.texturePaths).toEqual(["good.png"])
    expect(result.manifest.expressionIds).toEqual(["ok"])
    expect(result.manifest.motionGroups).toEqual([])
  })
})
