import {
  SITE_MANIFEST_RELATIVE_PATH,
  probeSiteSource,
  readSiteHostingManifestFile,
  resolveSiteManifestPath,
  resolveSiteSourceDir,
  writeSiteHostingManifestFile,
  type SiteManifestFileDeps,
} from "./manifest-file"

const site = { sourceRoot: "/repo", sourceSubpath: "apps/docs" }
const rootOnlySite = { sourceRoot: "/repo", sourceSubpath: "" }

const VALID = JSON.stringify({
  schemaVersion: 1,
  build: { command: ["pnpm", "build"], entry: ".cognia/worker.js", assets: "dist" },
  preview: { command: ["pnpm", "dev"], url: "http://localhost:5173" },
  cloudflare: { compatibilityDate: "2026-08-19", compatibilityFlags: [], bindings: [] },
})

function deps(overrides: Partial<SiteManifestFileDeps> = {}): Partial<SiteManifestFileDeps> {
  return {
    join: async (...parts: string[]) => parts.join("/"),
    readText: async () => VALID,
    writeText: async () => undefined,
    mkdir: async () => undefined,
    listDir: async () => [],
    pathExists: async () => true,
    ...overrides,
  }
}

describe("path resolution", () => {
  it("appends the subpath segments to the source root", async () => {
    const join = async (...parts: string[]) => parts.join("/")
    await expect(resolveSiteSourceDir(site, join)).resolves.toBe("/repo/apps/docs")
    await expect(resolveSiteManifestPath(site, join)).resolves.toBe(
      "/repo/apps/docs/.cognia/hosting.json"
    )
  })

  it("uses the source root directly when there is no subpath", async () => {
    const join = async (...parts: string[]) => parts.join("/")
    await expect(resolveSiteSourceDir(rootOnlySite, join)).resolves.toBe("/repo")
    await expect(resolveSiteManifestPath(rootOnlySite, join)).resolves.toBe(
      `/repo/${SITE_MANIFEST_RELATIVE_PATH}`
    )
  })
})

describe("readSiteHostingManifestFile", () => {
  it("parses a present manifest and returns both text and value", async () => {
    const result = await readSiteHostingManifestFile(site, deps())
    expect(result.status).toBe("ok")
    if (result.status !== "ok") throw new Error("unreachable")
    expect(result.path).toBe("/repo/apps/docs/.cognia/hosting.json")
    expect(result.text).toBe(VALID)
    expect(result.manifest.build.assets).toBe("dist")
  })

  it("reports absence as its own state without reading the file", async () => {
    const readText = jest.fn(async () => VALID)
    const result = await readSiteHostingManifestFile(
      site,
      deps({ pathExists: async () => false, readText })
    )
    expect(result).toEqual({ status: "missing", path: "/repo/apps/docs/.cognia/hosting.json" })
    expect(readText).not.toHaveBeenCalled()
  })

  it("keeps the text and the parser message when the manifest is invalid", async () => {
    const result = await readSiteHostingManifestFile(
      site,
      deps({ readText: async () => '{"schemaVersion": 2}' })
    )
    expect(result.status).toBe("invalid")
    if (result.status !== "invalid") throw new Error("unreachable")
    expect(result.text).toBe('{"schemaVersion": 2}')
    expect(result.error).toMatch(/schema version/i)
  })

  it("treats an unreadable-but-present file as missing", async () => {
    const result = await readSiteHostingManifestFile(
      site,
      deps({
        readText: async () => {
          throw new Error("EACCES")
        },
      })
    )
    expect(result.status).toBe("missing")
  })
})

describe("writeSiteHostingManifestFile", () => {
  it("creates the manifest directory and writes the manifest last", async () => {
    const mkdir = jest.fn(async (_path: string, _options?: { recursive?: boolean }) => undefined)
    const writeText = jest.fn(async (_path: string, _contents: string) => undefined)
    const path = await writeSiteHostingManifestFile(
      site,
      { manifestText: VALID },
      deps({ mkdir, writeText })
    )
    expect(path).toBe("/repo/apps/docs/.cognia/hosting.json")
    expect(mkdir).toHaveBeenCalledWith("/repo/apps/docs/.cognia", { recursive: true })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith("/repo/apps/docs/.cognia/hosting.json", VALID)
  })

  it("writes companion files under their own parent directories first", async () => {
    const mkdir = jest.fn(async (_path: string, _options?: { recursive?: boolean }) => undefined)
    const writeText = jest.fn(async (_path: string, _contents: string) => undefined)
    await writeSiteHostingManifestFile(
      site,
      {
        manifestText: VALID,
        extraFiles: [{ relativePath: ".cognia/worker.js", contents: "export default {}" }],
      },
      deps({ mkdir, writeText })
    )
    expect(mkdir.mock.calls.map((call) => call[0])).toEqual([
      "/repo/apps/docs/.cognia",
      "/repo/apps/docs/.cognia",
    ])
    expect(writeText.mock.calls.map((call) => call[0])).toEqual([
      "/repo/apps/docs/.cognia/worker.js",
      "/repo/apps/docs/.cognia/hosting.json",
    ])
  })
})

describe("probeSiteSource", () => {
  it("collects the source listing, package.json, and the workspace root listing", async () => {
    const listDir = jest.fn(async (path: string) =>
      path === "/repo/apps/docs" ? ["package.json", "vite.config.ts"] : ["pnpm-lock.yaml"]
    )
    const readText = jest.fn(async () => '{"dependencies":{"vite":"7"}}')
    const probe = await probeSiteSource(site, deps({ listDir, readText }))
    expect(probe).toEqual({
      entries: ["package.json", "vite.config.ts"],
      rootEntries: ["pnpm-lock.yaml"],
      packageJson: '{"dependencies":{"vite":"7"}}',
    })
    expect(readText).toHaveBeenCalledWith("/repo/apps/docs/package.json")
  })

  it("skips the package.json read when the directory has none", async () => {
    const readText = jest.fn(async () => VALID)
    const probe = await probeSiteSource(
      site,
      deps({ listDir: async () => ["index.html"], readText })
    )
    expect(probe.packageJson).toBeUndefined()
    expect(readText).not.toHaveBeenCalled()
  })

  it("reuses one listing when the Site builds from the workspace root", async () => {
    const listDir = jest.fn(async () => ["index.html"])
    const probe = await probeSiteSource(rootOnlySite, deps({ listDir }))
    expect(listDir).toHaveBeenCalledTimes(1)
    expect(probe.rootEntries).toEqual(["index.html"])
  })

  it("tolerates an unreadable workspace root", async () => {
    const listDir = jest.fn(async (path: string) => {
      if (path === "/repo") throw new Error("EACCES")
      return ["index.html"]
    })
    const probe = await probeSiteSource(site, deps({ listDir }))
    expect(probe.rootEntries).toEqual([])
  })
})
