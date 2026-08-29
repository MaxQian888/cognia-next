import {
  SITE_BUILD_INPUT_DEFAULTS,
  packageManagerFromManifest,
  seedSiteBuildInputs,
} from "./build-inputs"
import type { SiteVersionRow } from "@/types/sites"

function version(over: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "s1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "abc", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@22",
      packageManager: "yarn@4",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
      installNetworkHosts: ["registry.internal"],
      buildNetworkHosts: ["cdn.example.com"],
    },
    createdAt: 1,
    ...over,
  }
}

const manifest = (install?: string[]) =>
  ({
    schemaVersion: 1,
    build: { command: ["build"], entry: "e.js", ...(install ? { install } : {}) },
    preview: { command: ["dev"], url: "http://localhost:1" },
    cloudflare: { compatibilityDate: "2026-01-01", compatibilityFlags: [], bindings: [] },
  }) as never

it("repeats the newest completed build's inputs", () => {
  // A rebuild should repeat a build, not re-derive one.
  const { inputs, source } = seedSiteBuildInputs([version({ id: "v1" })])
  expect(source).toBe("last-version")
  expect(inputs).toEqual({
    runtime: "node@22",
    packageManager: "yarn@4",
    installNetworkHosts: ["registry.internal"],
    buildNetworkHosts: ["cdn.example.com"],
  })
})

it("takes the newest by sequence, whatever order they arrive in", () => {
  const { inputs } = seedSiteBuildInputs([
    version({ id: "old", sequence: 1 }),
    version({
      id: "new",
      sequence: 2,
      build: { ...version({ id: "x" }).build, runtime: "node@20" },
    }),
  ])
  expect(inputs.runtime).toBe("node@20")
})

it("ignores a build still in flight, whose inputs are not yet a fact", () => {
  const { source } = seedSiteBuildInputs([version({ id: "v1", sequence: 9, status: "building" })])
  expect(source).toBe("default")
})

it("still seeds from a failed build — its inputs are exactly what to correct", () => {
  const { source } = seedSiteBuildInputs([version({ id: "v1", status: "failed" })])
  expect(source).toBe("last-version")
})

it("falls back to the defaults for hosts a pre-recording version does not carry", () => {
  // Claiming "no network" for an older build would be a different build.
  const legacy = version({ id: "v1" })
  delete (legacy.build as Record<string, unknown>).installNetworkHosts
  delete (legacy.build as Record<string, unknown>).buildNetworkHosts
  const { inputs } = seedSiteBuildInputs([legacy])
  expect(inputs.installNetworkHosts).toEqual(SITE_BUILD_INPUT_DEFAULTS.installNetworkHosts)
  expect(inputs.buildNetworkHosts).toEqual([])
})

it("infers the package manager from the manifest before anything is built", () => {
  const { inputs, source } = seedSiteBuildInputs([], manifest(["yarn", "install"]))
  expect(source).toBe("manifest")
  expect(inputs.packageManager).toBe("yarn@4")
})

it("falls back to the defaults with neither a version nor a usable manifest", () => {
  expect(seedSiteBuildInputs([], manifest(["make", "deps"]))).toEqual({
    inputs: SITE_BUILD_INPUT_DEFAULTS,
    source: "default",
  })
  expect(seedSiteBuildInputs([]).source).toBe("default")
})

it("reads the package manager out of an install command", () => {
  expect(packageManagerFromManifest(manifest(["pnpm", "install"]))).toBe("pnpm")
  expect(packageManagerFromManifest(manifest(["bun", "install"]))).toBe("bun")
  expect(packageManagerFromManifest(manifest(["make"]))).toBeUndefined()
  expect(packageManagerFromManifest(undefined)).toBeUndefined()
})

it("does not hand out a shared mutable default", () => {
  const first = seedSiteBuildInputs([]).inputs
  first.installNetworkHosts.push("leaked.example.com")
  expect(seedSiteBuildInputs([]).inputs.installNetworkHosts).toEqual(["registry.npmjs.org"])
})
