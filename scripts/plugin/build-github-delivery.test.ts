/** @jest-environment node */
// esbuild's TextEncoder realm invariant does not hold under jsdom.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import JSZip from "jszip"

import {
  archivesEquivalent,
  buildGithubDeliveryArtifacts,
  findStaleArtifacts,
  githubDeliveryPaths,
  jsonEqual,
  writeGithubDeliveryArtifacts,
  type GithubDeliveryArtifacts,
  type GithubDeliveryPaths,
} from "./build-github-delivery"

const repoRoot = resolve(__dirname, "../..")

let artifacts: GithubDeliveryArtifacts
beforeAll(async () => {
  artifacts = await buildGithubDeliveryArtifacts(githubDeliveryPaths(repoRoot))
}, 60_000)

function tempPaths(dir: string): GithubDeliveryPaths {
  return {
    ...githubDeliveryPaths(repoRoot),
    manifestPath: join(dir, "plugin.json"),
    bundlePath: join(dir, "dist/index.js"),
    archivePath: join(dir, "compat/github-delivery.zip"),
  }
}

describe("jsonEqual", () => {
  it("ignores key order and compares nested values", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(jsonEqual([], {})).toBe(false)
    expect(jsonEqual(null, {})).toBe(false)
  })
})

describe("buildGithubDeliveryArtifacts", () => {
  it("emits a CommonJS bundle that only requires the host-shared SDK", () => {
    const required: string[] = []
    const pluginModule: { exports: Record<string, unknown> } = { exports: {} }
    runInNewContext(Buffer.from(artifacts.bundle).toString("utf8"), {
      module: pluginModule,
      exports: pluginModule.exports,
      require: (id: string) => {
        required.push(id)
        if (id === "@cognia/plugin-sdk") {
          return {
            definePlugin: (definition: unknown) => definition,
            definePluginManifest: (manifest: unknown) => manifest,
          }
        }
        throw new Error(`Unexpected runtime dependency: ${id}`)
      },
    })
    expect([...new Set(required)]).toEqual(["@cognia/plugin-sdk"])
    const manifest = (pluginModule.exports.default as { manifest: unknown }).manifest
    expect(
      jsonEqual(
        JSON.parse(JSON.stringify(manifest)),
        JSON.parse(artifacts.manifestBytes.toString())
      )
    ).toBe(true)
    expect(typeof pluginModule.exports.listGithubResources).toBe("function")
  })

  it("carries the Bot scope selectors into the packaged manifest", () => {
    const manifest = JSON.parse(artifacts.manifestBytes.toString()) as {
      integrations: Array<{ actions: Array<{ scopeSelectors?: unknown }> }>
    }
    for (const action of manifest.integrations[0].actions) {
      expect(action.scopeSelectors).toEqual([{ kind: "repository", jsonPointer: "/repoFullName" }])
    }
  })

  it("packages exactly the manifest and the bundle", async () => {
    const zip = await JSZip.loadAsync(artifacts.archiveBytes)
    expect(Object.keys(zip.files).sort()).toEqual(["dist/index.js", "plugin.json"])
  })
})

describe("--check", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "github-delivery-build-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("accepts a plugin.json that only differs in formatting", async () => {
    const paths = tempPaths(dir)
    await writeGithubDeliveryArtifacts(paths, artifacts)
    const parsed = JSON.parse(await readFile(paths.manifestPath, "utf8")) as unknown
    // Prettier collapses short arrays; the check must not care.
    await writeFile(paths.manifestPath, JSON.stringify(parsed))
    expect(await findStaleArtifacts(paths, artifacts)).toEqual([])
  })

  it("reports a manifest whose content changed", async () => {
    const paths = tempPaths(dir)
    await writeGithubDeliveryArtifacts(paths, artifacts)
    const parsed = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { version: string }
    await writeFile(paths.manifestPath, JSON.stringify({ ...parsed, version: "0.0.0" }))
    expect(await findStaleArtifacts(paths, artifacts)).toEqual([paths.manifestPath])
  })

  it("reports missing artifacts", async () => {
    const paths = tempPaths(dir)
    expect(await findStaleArtifacts(paths, artifacts)).toEqual([
      paths.manifestPath,
      paths.bundlePath,
      paths.archivePath,
    ])
  })

  it("compares archives by entry, formatting-insensitive for JSON only", async () => {
    const reformatted = new JSZip()
    reformatted.file("plugin.json", JSON.stringify(JSON.parse(artifacts.manifestBytes.toString())))
    reformatted.file("dist/index.js", artifacts.bundle)
    const reformattedBytes = await reformatted.generateAsync({ type: "uint8array" })
    expect(await archivesEquivalent(reformattedBytes, artifacts.archiveBytes)).toBe(true)

    const tampered = new JSZip()
    tampered.file("plugin.json", artifacts.manifestBytes)
    tampered.file("dist/index.js", `${Buffer.from(artifacts.bundle).toString()}\n// changed`)
    const tamperedBytes = await tampered.generateAsync({ type: "uint8array" })
    expect(await archivesEquivalent(tamperedBytes, artifacts.archiveBytes)).toBe(false)
  })

  it("keeps the committed plugin.json and compat ZIP in step with the source", async () => {
    const paths = githubDeliveryPaths(repoRoot)
    const stale = await findStaleArtifacts(paths, artifacts)
    // dist/ is gitignored build output; the committed artifacts must match.
    expect(stale.filter((path) => path !== paths.bundlePath)).toEqual([])
  })
})
