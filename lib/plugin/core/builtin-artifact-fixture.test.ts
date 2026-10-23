import {
  STAGE_BUILTINS_HINT,
  builtinArtifactManifest,
  loadBuiltinArtifactExports,
  stagedBuiltinFetch,
} from "./builtin-artifact-fixture"
import { getBrowserBuiltinRegistryEntry } from "./browser-builtin-registry"

describe("built-in artifact fixture", () => {
  it("serves a staged chunk byte-for-byte under its pinned URL", async () => {
    const asset = getBrowserBuiltinRegistryEntry("cognia-builtin-characters")!.asset!
    const response = await stagedBuiltinFetch()(asset.url)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")
    expect(digest).toBe(asset.sha256)
  })

  it("refuses URLs outside the built-in chunk tree and path traversal", async () => {
    const fetchStaged = stagedBuiltinFetch()
    await expect(fetchStaged("/plugins/x/plugin.json")).rejects.toThrow(/built-in chunks only/)
    await expect(fetchStaged("/_cognia/builtin-plugins/../../package.json")).rejects.toThrow(
      /refuses/
    )
  })

  it("names the staging command when a chunk is missing", async () => {
    await expect(
      stagedBuiltinFetch()("/_cognia/builtin-plugins/not-a-plugin/0.cjs")
    ).rejects.toThrow(STAGE_BUILTINS_HINT)
  })

  it("evaluates the shipped chunk into the plugin entry's exports", async () => {
    const exports = await loadBuiltinArtifactExports("cognia-builtin-characters")
    const definition = exports.default as { manifest: { id: string } }
    expect(definition.manifest.id).toBe("cognia-builtin-characters")
    expect(exports.BUILTIN_PACK).toMatchObject({ id: "builtin" })
  })

  it("reads the packaged manifest, and rejects ids that are not built-ins", () => {
    expect(builtinArtifactManifest("cognia-builtin-characters").main).toBe("dist/index.js")
    expect(() => builtinArtifactManifest("not-a-plugin")).toThrow(/not a browser built-in/)
  })
})
