import { MAX_MODEL_BYTES } from "./constants"
import { validateLive2dImport } from "./import-validate"
import type { ModelFileEntry } from "./types"
import { readBlobText } from "./read-blob-text"

function entry(path: string, content: BlobPart = path): ModelFileEntry {
  return { path, blob: new Blob([content]) }
}

function settingsBlob(json: unknown): Blob {
  return new Blob([JSON.stringify(json)])
}

const MODERN = {
  FileReferences: {
    Moc: "model.moc3",
    Textures: ["tex/t0.png", "tex/t1.png"],
    Physics: "physics.json",
    Pose: "pose.json",
  },
}

describe("validateLive2dImport", () => {
  it("validates a complete modern model", async () => {
    const entries: ModelFileEntry[] = [
      { path: "Char.model3.json", blob: settingsBlob(MODERN) },
      entry("model.moc3"),
      entry("tex/t0.png"),
      entry("tex/t1.png"),
      entry("physics.json"),
      entry("pose.json"),
    ]
    const result = await validateLive2dImport(entries)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model.manifest.mocPath).toBe("model.moc3")
    expect(result.model.manifest.physicsPath).toBe("physics.json")
    expect(result.model.totalBytes).toBeGreaterThan(0)
    expect(result.model.entries).toHaveLength(6)
  })

  it("flags noSettings when nothing looks like a model", async () => {
    const result = await validateLive2dImport([entry("readme.txt")])
    expect(result).toEqual({ ok: false, code: "noSettings" })
  })

  it("flags cubism2Unsupported when only a .model.json is present", async () => {
    const result = await validateLive2dImport([
      { path: "legacy.model.json", blob: settingsBlob({ model: "m.moc", textures: ["t.png"] }) },
      entry("m.moc"),
    ])
    expect(result).toEqual({ ok: false, code: "cubism2Unsupported" })
  })

  it("flags multipleSettings when two model3.json files are present", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      { path: "b.model3.json", blob: settingsBlob(MODERN) },
    ])
    expect(result).toEqual({ ok: false, code: "multipleSettings" })
  })

  it("propagates invalidJson from the parser", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: new Blob(["{not json"]) },
    ])
    expect(result).toEqual({ ok: false, code: "invalidJson" })
  })

  it("propagates cubism2Unsupported from a model3-named legacy-shaped file", async () => {
    const result = await validateLive2dImport([
      {
        path: "a.model3.json",
        blob: settingsBlob({ model: "m.moc", motions: { idle: [] } }),
      },
    ])
    expect(result).toEqual({ ok: false, code: "cubism2Unsupported" })
  })

  it("flags missingReferenced when the moc is absent and lists the gap", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("tex/t0.png"),
      entry("tex/t1.png"),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("missingReferenced")
    expect(result.detail).toContain("model.moc3")
  })

  it("flags missingReferenced when a texture is absent", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("model.moc3"),
      entry("tex/t0.png"),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("missingReferenced")
    expect(result.detail).toContain("tex/t1.png")
  })

  it("matches referenced files case-insensitively", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("MODEL.MOC3"),
      entry("TEX/T0.PNG"),
      entry("tex/t1.png"),
      entry("physics.json"),
      entry("pose.json"),
    ])
    expect(result.ok).toBe(true)
  })

  it("rejects ambiguous case-insensitive and duplicate normalized paths", async () => {
    const ambiguous = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("model.moc3"),
      entry("tex/t0.png"),
      entry("TEX/T0.PNG"),
      entry("tex/t1.png"),
    ])
    expect(ambiguous).toEqual(expect.objectContaining({ ok: false, code: "ambiguousPath" }))

    const duplicate = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("model.moc3"),
      entry("tex/./t0.png"),
      entry("tex/t0.png"),
      entry("tex/t1.png"),
    ])
    expect(duplicate).toEqual(expect.objectContaining({ ok: false, code: "duplicatePath" }))
  })

  it("rejects path traversal before persistence", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("../model.moc3"),
      entry("tex/t0.png"),
      entry("tex/t1.png"),
    ])
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "pathTraversal" }))
  })

  it("drops optional physics/pose from the manifest when their files are absent", async () => {
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(MODERN) },
      entry("model.moc3"),
      entry("tex/t0.png"),
      entry("tex/t1.png"),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model.manifest.physicsPath).toBeUndefined()
    expect(result.model.manifest.posePath).toBeUndefined()
  })

  it("sanitizes missing motions, expressions, sounds and metadata as a degraded model", async () => {
    const settings = {
      FileReferences: {
        Moc: "model.moc3",
        Textures: ["tex/t0.png"],
        Motions: {
          Idle: [{ File: "motions/idle.motion3.json", Sound: "sounds/idle.wav" }],
          Missing: [{ File: "motions/missing.motion3.json" }],
        },
        Expressions: [
          { Name: "happy", File: "expressions/happy.exp3.json" },
          { Name: "missing", File: "expressions/missing.exp3.json" },
        ],
        UserData: "userdata.json",
      },
    }
    const result = await validateLive2dImport([
      { path: "a.model3.json", blob: settingsBlob(settings) },
      entry("model.moc3"),
      entry("tex/t0.png"),
      entry("motions/idle.motion3.json"),
      entry("expressions/happy.exp3.json"),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.model.compatibility.status).toBe("degraded")
    expect(result.model.compatibility.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "missingMotion",
        "missingExpression",
        "missingSound",
        "missingMetadata",
      ])
    )
    expect(result.model.manifest.motionGroups).toEqual(["Idle"])
    expect(result.model.manifest.expressionIds).toEqual(["happy"])
    const storedSettings = result.model.entries.find((item) => item.path === "a.model3.json")!
    const sanitized = JSON.parse(await readBlobText(storedSettings.blob))
    expect(sanitized.FileReferences.Motions.Idle[0].Sound).toBeUndefined()
    expect(sanitized.FileReferences.Motions.Missing).toBeUndefined()
    expect(sanitized.FileReferences.UserData).toBeUndefined()
  })

  it("rejects a typed texture with a corrupt image signature", async () => {
    const result = await validateLive2dImport([
      {
        path: "a.model3.json",
        blob: settingsBlob({ FileReferences: { Moc: "model.moc3", Textures: ["bad.png"] } }),
      },
      entry("model.moc3"),
      { path: "bad.png", blob: new Blob(["not-png"], { type: "image/png" }) },
    ])
    expect(result).toEqual({ ok: false, code: "corruptTexture", detail: "bad.png" })
  })

  it("flags tooLarge when the bundle exceeds the cap", async () => {
    const big = { size: MAX_MODEL_BYTES + 1, text: async () => JSON.stringify(MODERN) }
    const entries: ModelFileEntry[] = [
      { path: "a.model3.json", blob: big as unknown as Blob },
      { path: "model.moc3", blob: { size: 0 } as unknown as Blob },
      { path: "tex/t0.png", blob: { size: 0 } as unknown as Blob },
      { path: "tex/t1.png", blob: { size: 0 } as unknown as Blob },
    ]
    const result = await validateLive2dImport(entries)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("tooLarge")
    expect(result.detail).toBe(String(MAX_MODEL_BYTES + 1))
  })

  it("returns invalidJson when reading the settings blob throws", async () => {
    const throwingBlob = {
      size: 10,
      text: async () => {
        throw new Error("read fail")
      },
    } as unknown as Blob
    const result = await validateLive2dImport([{ path: "a.model3.json", blob: throwingBlob }])
    expect(result).toEqual({ ok: false, code: "invalidJson" })
  })
})
