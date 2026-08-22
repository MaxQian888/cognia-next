import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import {
  checkCoverage,
  checkLaunchParity,
  checkPinning,
  checkPlatforms,
  checkProbes,
  checkSchema,
  checkWaivers,
  runChecks,
  shippedPresetIds,
} from "./check-external-agent-runtimes.mjs"

const SHA = "a".repeat(64)

const POLICY = {
  binaryAllowlist: { commands: ["codex", "droid"] },
  npxPackageAllowlist: { packages: ["@zed-industries/codex-acp"] },
}

const PRESETS_SOURCE = `
export type ExternalAgentPresetId =
  | "codex"
  | "droid"
  | "custom"

/** next block */
`

function runtime(overrides = {}) {
  return {
    runtimeId: "droid",
    presetIds: ["droid"],
    displayName: "Droid",
    ownership: "system",
    protocol: "acp",
    transport: "stdio",
    platforms: ["darwin", "linux"],
    systemCommand: "droid",
    launchArgs: [],
    versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 10000 },
    distributions: [],
    sandbox: { required: true, windowsExceptionEligible: false },
    ...overrides,
  }
}

function catalog(runtimes, waivers = {}) {
  return { version: 1, runtimes, unpinnedLaunchWaivers: { runtimes: waivers } }
}

// ---------------------------------------------------------------------------

test("the real catalog passes every check", () => {
  assert.deepEqual(runChecks(), [])
})

test("shippedPresetIds reads the preset union and drops custom", () => {
  assert.deepEqual(shippedPresetIds(PRESETS_SOURCE), ["codex", "droid"])
})

// --- schema ----------------------------------------------------------------

test("schema rejects a duplicate runtime id", () => {
  const errors = checkSchema(catalog([runtime(), runtime()]))
  assert.ok(errors.some((e) => e.includes("duplicate runtimeId")))
})

test("schema requires a system runtime to name its command", () => {
  const errors = checkSchema(catalog([runtime({ systemCommand: undefined })]))
  assert.ok(errors.some((e) => e.includes("must name the command it launches")))
})

test("schema rejects a remote runtime that claims a local command", () => {
  const errors = checkSchema(
    catalog([runtime({ ownership: "remote", versionProbe: undefined, systemCommand: "droid" })])
  )
  assert.ok(errors.some((e) => e.includes("launches nothing locally")))
})

test("schema requires a version probe for anything launched locally", () => {
  const errors = checkSchema(catalog([runtime({ versionProbe: undefined })]))
  assert.ok(errors.some((e) => e.includes("how to read its version")))
})

test("schema rejects an unbounded version probe", () => {
  const errors = checkSchema(
    catalog([runtime({ versionProbe: { args: [], parser: "semver-anywhere", timeoutMs: 0 } })])
  )
  assert.ok(errors.some((e) => e.includes("positive bound")))
})

test("schema rejects certified versions with no range to sit inside", () => {
  const errors = checkSchema(catalog([runtime({ certifiedVersions: ["1.0.0"] })]))
  assert.ok(errors.some((e) => e.includes("without a supportedRange")))
})

test("schema rejects an inexact certified version", () => {
  const errors = checkSchema(
    catalog([runtime({ supportedRange: ">=1.0.0", certifiedVersions: ["^1.0.0"] })])
  )
  assert.ok(errors.some((e) => e.includes("not an exact version")))
})

test("schema accepts a well-formed entry", () => {
  assert.deepEqual(checkSchema(catalog([runtime()])), [])
})

// --- coverage --------------------------------------------------------------

test("coverage fails when a shipped preset has no runtime", () => {
  const errors = checkCoverage(catalog([runtime()]), PRESETS_SOURCE)
  assert.ok(errors.some((e) => e.includes('preset "codex" has no runtime catalog entry')))
})

test("coverage fails when a runtime names a preset the app does not ship", () => {
  const errors = checkCoverage(
    catalog([
      runtime({ presetIds: ["droid", "ghost"] }),
      runtime({ runtimeId: "c", presetIds: ["codex"] }),
    ]),
    PRESETS_SOURCE
  )
  assert.ok(errors.some((e) => e.includes('"ghost"')))
})

test("coverage fails when two runtimes claim the same preset", () => {
  const errors = checkCoverage(
    catalog([runtime(), runtime({ runtimeId: "other" })]),
    PRESETS_SOURCE
  )
  assert.ok(errors.some((e) => e.includes("claimed by both")))
})

// --- pinning ---------------------------------------------------------------

const lockDeps = {
  fileExists: () => true,
  readFile: () => Buffer.from("lock-bytes"),
}
const LOCK_DIGEST = createHash("sha256").update("lock-bytes").digest("hex")

function jsDistribution(overrides = {}) {
  return {
    provider: "npm",
    packageName: "@example/agent",
    version: "1.2.3",
    entrypoint: "node_modules/.bin/example",
    lockAsset: { path: "runtime/example/package-lock.json", sha256: LOCK_DIGEST },
    ...overrides,
  }
}

test("pinning accepts an exact version with a matching lock", () => {
  const errors = checkPinning(catalog([runtime({ distributions: [jsDistribution()] })]), lockDeps)
  assert.deepEqual(errors, [])
})

test("pinning rejects a range instead of an exact version", () => {
  for (const version of ["^1.2.3", "latest", "1.2", ">=1.0.0"]) {
    const errors = checkPinning(
      catalog([runtime({ distributions: [jsDistribution({ version })] })]),
      lockDeps
    )
    assert.ok(
      errors.some((e) => e.includes("is not exact")),
      `expected "${version}" to be rejected`
    )
  }
})

test("pinning rejects a distribution with no lock asset", () => {
  const errors = checkPinning(
    catalog([runtime({ distributions: [jsDistribution({ lockAsset: undefined })] })]),
    lockDeps
  )
  assert.ok(errors.some((e) => e.includes("must not be offered")))
})

test("pinning rejects a lock whose bytes do not match the catalog digest", () => {
  const errors = checkPinning(
    catalog([
      runtime({ distributions: [jsDistribution({ lockAsset: { path: "p", sha256: SHA } })] }),
    ]),
    lockDeps
  )
  assert.ok(errors.some((e) => e.includes("hashes to")))
})

test("pinning rejects a lock file that does not exist", () => {
  const errors = checkPinning(catalog([runtime({ distributions: [jsDistribution()] })]), {
    ...lockDeps,
    fileExists: () => false,
  })
  assert.ok(errors.some((e) => e.includes("does not exist")))
})

test("pinning rejects a managed install with nothing to launch", () => {
  const errors = checkPinning(
    catalog([runtime({ distributions: [jsDistribution({ entrypoint: undefined })] })]),
    lockDeps
  )
  assert.ok(errors.some((e) => e.includes("nothing to launch")))
})

test("pinning requires https and a checksum on every binary artifact", () => {
  const binary = {
    provider: "binary",
    version: "1.0.0",
    artifacts: [
      {
        platformKey: "darwin-arm64",
        url: "http://example.test/a.tar.gz",
        integrity: {},
        archive: "tar.gz",
      },
    ],
  }
  const errors = checkPinning(catalog([runtime({ distributions: [binary] })]), lockDeps)
  assert.ok(errors.some((e) => e.includes("not served over https")))
  assert.ok(errors.some((e) => e.includes("has no SHA-256")))
  assert.ok(errors.some((e) => e.includes("names no entrypoint")))
})

test("pinning rejects a binary distribution with no artifacts", () => {
  const errors = checkPinning(
    catalog([
      runtime({ distributions: [{ provider: "binary", version: "1.0.0", artifacts: [] }] }),
    ]),
    lockDeps
  )
  assert.ok(errors.some((e) => e.includes("at least one artifact")))
})

test("pinning rejects an unknown provider", () => {
  const errors = checkPinning(
    catalog([runtime({ distributions: [{ provider: "curl", version: "1.0.0" }] })]),
    lockDeps
  )
  assert.ok(errors.some((e) => e.includes("unknown provider")))
})

// --- waivers ---------------------------------------------------------------

const unpinned = runtime({
  runtimeId: "codex-acp",
  presetIds: ["codex"],
  systemCommand: "npx",
  launchArgs: ["-y", "@zed-industries/codex-acp"],
})

test("waivers fail an unpinned launch with no reason recorded", () => {
  const errors = checkWaivers(catalog([unpinned]))
  assert.ok(errors.some((e) => e.includes("no waiver")))
})

test("waivers fail a reason too short to be a reason", () => {
  const errors = checkWaivers(catalog([unpinned], { "codex-acp": "todo" }))
  assert.ok(errors.some((e) => e.includes("too short")))
})

test("waivers accept an unpinned launch with a written reason", () => {
  const errors = checkWaivers(
    catalog([unpinned], {
      "codex-acp": "No vetted lock asset has been curated for a pinned version yet.",
    })
  )
  assert.deepEqual(errors, [])
})

test("waivers reject a stale row, so the list can only shrink", () => {
  const errors = checkWaivers(
    catalog([runtime()], { droid: "This runtime was pinned last release but the row stayed." })
  )
  assert.ok(errors.some((e) => e.includes("remove the waiver")))
})

test("waivers detect a package runner behind a Windows suffix", () => {
  const errors = checkWaivers(catalog([runtime({ systemCommand: "npx.cmd" })]))
  assert.ok(errors.some((e) => e.includes("no waiver")))
})

test("waivers require the block to exist at all", () => {
  const errors = checkWaivers({ version: 1, runtimes: [] })
  assert.ok(errors.some((e) => e.includes("missing unpinnedLaunchWaivers")))
})

// --- launch parity ---------------------------------------------------------

test("launch parity fails a command outside the security policy allowlist", () => {
  const errors = checkLaunchParity(catalog([runtime({ systemCommand: "rogue" })]), POLICY)
  assert.ok(errors.some((e) => e.includes("binary allowlist")))
})

test("launch parity fails a package outside the npx allowlist", () => {
  const errors = checkLaunchParity(
    catalog([runtime({ systemCommand: "npx", launchArgs: ["-y", "@evil/pkg"] })]),
    POLICY
  )
  assert.ok(errors.some((e) => e.includes("npx allowlist")))
})

test("launch parity fails a package runner that names no package", () => {
  const errors = checkLaunchParity(
    catalog([runtime({ systemCommand: "npx", launchArgs: ["-y"] })]),
    POLICY
  )
  assert.ok(errors.some((e) => e.includes("names no package")))
})

test("launch parity accepts allowlisted commands and packages", () => {
  assert.deepEqual(checkLaunchParity(catalog([runtime(), unpinned]), POLICY), [])
})

test("launch parity ignores a remote runtime with no command", () => {
  assert.deepEqual(
    checkLaunchParity(
      catalog([runtime({ ownership: "remote", systemCommand: undefined })]),
      POLICY
    ),
    []
  )
})

// --- platforms -------------------------------------------------------------

test("platforms reject an unknown platform id", () => {
  const errors = checkPlatforms(catalog([runtime({ platforms: ["darwin", "solaris"] })]))
  assert.ok(errors.some((e) => e.includes('unknown platform "solaris"')))
})

test("platforms reject a runtime that supports nothing", () => {
  const errors = checkPlatforms(catalog([runtime({ platforms: [] })]))
  assert.ok(errors.some((e) => e.includes("supports no platform")))
})

test("platforms reject a Windows-eligible runtime that does not support Windows", () => {
  const errors = checkPlatforms(
    catalog([
      runtime({
        platforms: ["darwin"],
        sandbox: { required: true, windowsExceptionEligible: true },
      }),
    ])
  )
  assert.ok(errors.some((e) => e.includes("does not support win32")))
})

// --- probes ----------------------------------------------------------------

test("probes reject a package runner that probes a different package than it launches", () => {
  // The shape the catalog shipped with: `args: ["--version"]` alone, which
  // resolves to `npx --version` — the runner's own version, not the runtime's.
  const errors = checkProbes(
    catalog([
      runtime({
        systemCommand: "npx",
        launchArgs: ["-y", "@zed-industries/codex-acp"],
        versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 20000 },
      }),
    ])
  )
  assert.ok(errors.some((e) => e.includes("would not be the version that runs")))
})

test("probes accept a package runner that names the launched package", () => {
  assert.deepEqual(
    checkProbes(
      catalog([
        runtime({
          systemCommand: "npx",
          launchArgs: ["-y", "@zed-industries/codex-acp", "--acp"],
          versionProbe: {
            args: ["-y", "@zed-industries/codex-acp", "--version"],
            parser: "semver-anywhere",
            timeoutMs: 20000,
          },
        }),
      ])
    ),
    []
  )
})

test("probes reject one that repeats a launch mode flag", () => {
  const errors = checkProbes(
    catalog([
      runtime({
        systemCommand: "copilot",
        launchArgs: ["--acp"],
        versionProbe: { args: ["--acp", "--version"], parser: "semver-anywhere", timeoutMs: 10000 },
      }),
    ])
  )
  assert.ok(errors.some((e) => e.includes('repeats the launch flag "--acp"')))
})

test("probes tolerate the runner's own -y, which is not a launch mode", () => {
  assert.deepEqual(
    checkProbes(
      catalog([
        runtime({
          systemCommand: "npx",
          launchArgs: ["-y", "pi-acp"],
          versionProbe: {
            args: ["-y", "pi-acp", "--version"],
            parser: "semver-anywhere",
            timeoutMs: 20000,
          },
        }),
      ])
    ),
    []
  )
})

test("probes reject an empty argument vector", () => {
  const errors = checkProbes(
    catalog([runtime({ versionProbe: { args: [], parser: "semver-anywhere", timeoutMs: 10000 } })])
  )
  assert.ok(errors.some((e) => e.includes("starts the agent")))
})

test("probes allow a managed runtime with no command, and reject a system one", () => {
  const managed = checkProbes(
    catalog([runtime({ ownership: "managed", systemCommand: undefined })])
  )
  assert.deepEqual(managed, [])

  const system = checkProbes(catalog([runtime({ systemCommand: undefined })]))
  assert.ok(system.some((e) => e.includes("names no command to run it against")))
})

// --- orchestration ---------------------------------------------------------

test("a schema failure short-circuits instead of cascading", () => {
  const errors = runChecks({
    catalog: catalog([{ runtimeId: "broken" }]),
    policy: POLICY,
    presetsSource: PRESETS_SOURCE,
  })
  assert.ok(errors.length > 0)
  assert.ok(errors.every((e) => e.startsWith("broken:") || e.includes("external-agent-runtimes")))
})
