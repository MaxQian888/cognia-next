import browserBuiltinAssets from "./browser-builtin-assets.generated.json"
import { getBuiltinPrebootManifest, listBuiltinPrebootManifests } from "./builtin-preboot-manifests"

const FIELDS = ["dexie", "characterPacks"] as const

/** The committed asset index, projected the way the generator projects it. */
function projectedFromIndex(): Record<string, Record<string, unknown>> {
  const entries = browserBuiltinAssets.entries as unknown as Record<
    string,
    { manifest: Record<string, unknown> }
  >
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, { manifest }] of Object.entries(entries)) {
    const fields = FIELDS.filter((field) => manifest[field] !== undefined)
    if (fields.length === 0) continue
    out[id] = {
      version: manifest.version,
      ...Object.fromEntries(fields.map((field) => [field, manifest[field]])),
    }
  }
  return out
}

describe("built-in pre-boot manifests", () => {
  it("is the asset index projected to its pre-boot fields, so the two committed files agree", () => {
    expect(Object.fromEntries(listBuiltinPrebootManifests())).toEqual(projectedFromIndex())
  })

  it("carries the Dexie tables and the built-in character pack the boot path reads", () => {
    expect(getBuiltinPrebootManifest("sre-agent")?.dexie?.tables.map((t) => t.name)).toEqual([
      "incidents",
    ])
    expect(
      getBuiltinPrebootManifest("cognia-builtin-characters")?.characterPacks?.map((p) => p.id)
    ).toContain("builtin")
  })

  it("returns undefined for plugins without pre-boot fields and for inherited keys", () => {
    expect(getBuiltinPrebootManifest("cognia-pdf")).toBeUndefined()
    expect(getBuiltinPrebootManifest("not-a-plugin")).toBeUndefined()
    expect(getBuiltinPrebootManifest("constructor")).toBeUndefined()
  })
})
