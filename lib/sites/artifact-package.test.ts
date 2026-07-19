import {
  inspectSiteArtifact,
  materializeSiteArtifact,
  packageSiteArtifact,
} from "./artifact-package"

describe("Sites immutable artifact package", () => {
  it("creates deterministic, content-addressed archives with an embedded manifest", async () => {
    const input = {
      entry: "dist/worker.js",
      assets: "dist/assets",
      files: [
        { path: "dist/assets/index.html", bytes: new TextEncoder().encode("<h1>Docs</h1>") },
        { path: "dist/worker.js", bytes: new TextEncoder().encode("export default {}") },
      ],
    }
    const first = await packageSiteArtifact(input)
    const second = await packageSiteArtifact({ ...input, files: [...input.files].reverse() })

    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(second.digest).toBe(first.digest)
    await expect(inspectSiteArtifact(first.bytes)).resolves.toEqual({
      schemaVersion: 1,
      entry: "dist/worker.js",
      assets: "dist/assets",
      files: ["dist/assets/index.html", "dist/worker.js"],
    })
  })

  it("rejects missing entries, empty assets, duplicate paths, and traversal", async () => {
    const file = { path: "dist/worker.js", bytes: new Uint8Array([1]) }
    await expect(packageSiteArtifact({ entry: "missing.js", files: [file] })).rejects.toThrow(
      "entry"
    )
    await expect(
      packageSiteArtifact({ entry: file.path, assets: "dist/assets", files: [file] })
    ).rejects.toThrow("assets")
    await expect(packageSiteArtifact({ entry: file.path, files: [file, file] })).rejects.toThrow(
      "duplicate"
    )
    await expect(
      packageSiteArtifact({ entry: "../worker.js", files: [{ ...file, path: "../worker.js" }] })
    ).rejects.toThrow("escape")
  })

  it("materializes only the manifest-declared files beneath the staging root", async () => {
    const artifact = await packageSiteArtifact({
      entry: "worker.js",
      assets: "assets",
      files: [
        { path: "worker.js", bytes: new Uint8Array([1]) },
        { path: "assets/index.html", bytes: new Uint8Array([2]) },
      ],
    })
    const writes: Array<[string, number[]]> = []
    const result = await materializeSiteArtifact(artifact.bytes, "/stage", {
      join: async (...parts) => parts.join("/"),
      mkdir: async () => undefined,
      write: async (path, bytes) => {
        writes.push([path, Array.from(bytes)])
      },
    })

    expect(result).toEqual({
      entryPath: "/stage/worker.js",
      assetsPath: "/stage/assets",
      fileCount: 2,
    })
    expect(writes).toEqual([
      ["/stage/assets/index.html", [2]],
      ["/stage/worker.js", [1]],
    ])
  })
})
