import fs from "node:fs"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dirname, "..")
const workspaceRoot = path.resolve(packageRoot, "..")

const sdk = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  license: string
  files: string[]
  optionalDependencies: Record<string, string>
  dependencies?: Record<string, string>
}

/**
 * The Apache boundary is a constraint on what the client may contain, not just
 * a field in package.json. `@cognia/agent` can only be Apache-2.0 while it stays
 * transport-only: any host source or host binary that lands inside it silently
 * relicenses the tarball.
 */
describe("licensing boundary", () => {
  it("publishes the client under Apache-2.0", () => {
    expect(sdk.license).toBe("Apache-2.0")
  })

  it("ships the Apache licence text with the package", () => {
    expect(sdk.files).toContain("LICENSE")
    const text = fs.readFileSync(path.join(packageRoot, "LICENSE"), "utf8")
    expect(text).toContain("Apache License")
    expect(text).toContain("Version 2.0, January 2004")
    expect(text).not.toMatch(/AFFERO/i)
  })

  it("keeps every platform host on AGPL, where the runtime actually lives", () => {
    for (const suffix of ["darwin-arm64", "linux-x64", "win32-x64"]) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(workspaceRoot, `agent-host-${suffix}`, "package.json"), "utf8")
      ) as { license: string }
      expect(manifest.license).toBe("AGPL-3.0-only")
    }
  })

  it("never ships the host source tree from the client package", () => {
    // `files` is an allowlist; anything outside it cannot reach the tarball.
    expect(sdk.files.sort()).toEqual(["LICENSE", "README.md", "dist"])
  })

  it("pins each optional host to an exact version", () => {
    const ranges = Object.values(sdk.optionalDependencies)
    expect(ranges.length).toBeGreaterThan(0)
    for (const range of ranges) {
      expect(range).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    }
  })

  it("takes no runtime dependency that is not permissively licensed", () => {
    // valibot is MIT. A copyleft runtime dependency would defeat the Apache
    // claim just as surely as vendoring the host would.
    expect(Object.keys(sdk.dependencies ?? {})).toEqual(["valibot"])
  })
})
