import { discoverLive2dModels, deriveModelName } from "./discover-models"
import type { ModelFileEntry } from "./types"

function entry(path: string, content = path): ModelFileEntry {
  return { path, blob: new Blob([content]) }
}

/** A `*.model3.json` entry with the given moc + texture references. */
function settings(path: string, moc: string, textures: string[]): ModelFileEntry {
  return {
    path,
    blob: new Blob([
      JSON.stringify({ Version: 3, FileReferences: { Moc: moc, Textures: textures } }),
    ]),
  }
}

describe("deriveModelName", () => {
  it("strips the settings suffix and the directory", () => {
    expect(deriveModelName("a/b/Hiyori.model3.json")).toBe("Hiyori")
    expect(deriveModelName("Mark.model.json")).toBe("Mark")
  })

  it("keeps the filename when stripping leaves nothing", () => {
    expect(deriveModelName(".model3.json")).toBe(".model3.json")
  })
})

describe("discoverLive2dModels", () => {
  it("returns [] when there is no settings file", async () => {
    expect(await discoverLive2dModels([entry("readme.txt"), entry("a/foo.png")])).toEqual([])
  })

  it("discovers a model whose files live at the bundle root", async () => {
    const result = await discoverLive2dModels([
      settings("Root.model3.json", "Root.moc3", ["root.png"]),
      entry("Root.moc3"),
      entry("root.png"),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].valid).toBe(true)
    expect(result[0].entries.map((e) => e.path).sort()).toEqual([
      "Root.moc3",
      "Root.model3.json",
      "root.png",
    ])
  })

  it("discovers a single model with its files and a derived name", async () => {
    const result = await discoverLive2dModels([
      settings("Char/Char.model3.json", "Char.moc3", ["tex/a.png"]),
      entry("Char/Char.moc3"),
      entry("Char/tex/a.png"),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].valid).toBe(true)
    expect(result[0].name).toBe("Char")
    expect(result[0].settingsPath).toBe("Char/Char.model3.json")
    expect(result[0].totalBytes).toBeGreaterThan(0)
  })

  it("groups each model's files (including motions) and never leaks across models", async () => {
    const result = await discoverLive2dModels([
      settings("CharA/CharA.model3.json", "CharA.moc3", ["tex/a.png"]),
      entry("CharA/CharA.moc3"),
      entry("CharA/tex/a.png"),
      entry("CharA/motions/idle.motion3.json"),
      settings("CharB/CharB.model3.json", "CharB.moc3", ["tex/b.png"]),
      entry("CharB/CharB.moc3"),
      entry("CharB/tex/b.png"),
    ])
    expect(result).toHaveLength(2)
    const a = result.find((m) => m.key === "CharA/CharA.model3.json")!
    expect(a.valid).toBe(true)
    expect(a.entries.map((e) => e.path).sort()).toEqual([
      "CharA/CharA.moc3",
      "CharA/CharA.model3.json",
      "CharA/motions/idle.motion3.json",
      "CharA/tex/a.png",
    ])
    expect(a.entries.some((e) => e.path.startsWith("CharB"))).toBe(false)
  })

  it("assigns nested-model files to the deepest model directory", async () => {
    const result = await discoverLive2dModels([
      settings("Pack/Pack.model3.json", "Pack.moc3", ["p.png"]),
      entry("Pack/Pack.moc3"),
      entry("Pack/p.png"),
      settings("Pack/sub/Sub.model3.json", "Sub.moc3", ["s.png"]),
      entry("Pack/sub/Sub.moc3"),
      entry("Pack/sub/s.png"),
    ])
    const pack = result.find((m) => m.key === "Pack/Pack.model3.json")!
    expect(pack.valid).toBe(true)
    expect(pack.entries.some((e) => e.path.startsWith("Pack/sub/"))).toBe(false)
    const sub = result.find((m) => m.key === "Pack/sub/Sub.model3.json")!
    expect(sub.valid).toBe(true)
    expect(sub.entries.map((e) => e.path).sort()).toEqual([
      "Pack/sub/Sub.moc3",
      "Pack/sub/Sub.model3.json",
      "Pack/sub/s.png",
    ])
  })

  it("splits two settings files sharing one directory into two valid models", async () => {
    const result = await discoverLive2dModels([
      settings("Char/a.model3.json", "shared.moc3", ["shared.png"]),
      settings("Char/b.model3.json", "shared.moc3", ["shared.png"]),
      entry("Char/shared.moc3"),
      entry("Char/shared.png"),
    ])
    expect(result).toHaveLength(2)
    const a = result.find((m) => m.key === "Char/a.model3.json")!
    expect(a.valid).toBe(true)
    expect(a.entries.map((e) => e.path).sort()).toEqual([
      "Char/a.model3.json",
      "Char/shared.moc3",
      "Char/shared.png",
    ])
    // The sibling settings file is excluded so validation sees exactly one.
    expect(a.entries.some((e) => e.path === "Char/b.model3.json")).toBe(false)
  })

  it("flags invalid models without affecting the valid ones, sorted by path", async () => {
    const result = await discoverLive2dModels([
      settings("Good/g.model3.json", "g.moc3", ["g.png"]),
      entry("Good/g.moc3"),
      entry("Good/g.png"),
      // Bad references a moc that is not present in its group.
      settings("Bad/b.model3.json", "b.moc3", ["b.png"]),
      entry("Bad/b.png"),
    ])
    expect(result.map((m) => m.settingsPath)).toEqual(["Bad/b.model3.json", "Good/g.model3.json"])
    const bad = result.find((m) => m.key === "Bad/b.model3.json")!
    expect(bad.valid).toBe(false)
    expect(bad.errorCode).toBe("missingReferenced")
    const good = result.find((m) => m.key === "Good/g.model3.json")!
    expect(good.valid).toBe(true)
  })
})
