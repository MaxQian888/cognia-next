import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CHANNEL_MANIFEST_FILE,
  DshInstallError,
  RUNTIME_ARTIFACTS,
  computeCompositionDigest,
  doctorInstalledDshRuntime,
  dshHomeFor,
  findStrayPatchLayers,
  installDshRuntime,
  removeDshRuntime,
  runtimeHomeFor,
} from "./dsh-installer"

let dataRoot: string
let sourceDir: string

/** A fake `npm install`: writes a lockfile and a node_modules marker. */
async function fakeNpmInstall(cwd: string): Promise<void> {
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "x", version: "0" }))
  fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true })
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-data-"))
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-src-"))
  for (const artifact of RUNTIME_ARTIFACTS) {
    fs.writeFileSync(path.join(sourceDir, artifact), `# ${artifact}\n`)
  }
})

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  fs.rmSync(sourceDir, { recursive: true, force: true })
})

function install(overrides: Partial<Parameters<typeof installDshRuntime>[0]> = {}) {
  return installDshRuntime({
    dataRoot,
    sourceDir,
    runNpmInstall: fakeNpmInstall,
    ...overrides,
  })
}

describe("computeCompositionDigest", () => {
  it("is stable for identical content", () => {
    expect(computeCompositionDigest(sourceDir)).toBe(computeCompositionDigest(sourceDir))
  })

  it("changes when a composition changes", () => {
    const before = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "# tampered\n")
    expect(computeCompositionDigest(sourceDir)).not.toBe(before)
  })

  it("distinguishes content moved between files", () => {
    // Length and name are folded in, so a byte swap cannot collide.
    const before = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "AB")
    fs.writeFileSync(path.join(sourceDir, "host.sdk-workspace.yml"), "")
    const first = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "")
    fs.writeFileSync(path.join(sourceDir, "host.sdk-workspace.yml"), "AB")
    expect(computeCompositionDigest(sourceDir)).not.toBe(first)
    expect(first).not.toBe(before)
  })
})

describe("installDshRuntime", () => {
  it("installs the artifacts and writes a channel manifest", async () => {
    const channel = await install()
    const home = runtimeHomeFor(dataRoot)
    for (const artifact of RUNTIME_ARTIFACTS) {
      expect(fs.existsSync(path.join(home, artifact))).toBe(true)
    }
    expect(fs.existsSync(path.join(home, CHANNEL_MANIFEST_FILE))).toBe(true)
    expect(channel.schemaVersion).toBe(1)
    expect(channel.experimental).toBe(true)
  })

  it("creates the pinned DSH_HOME inside the runtime home", async () => {
    // The launcher refuses to boot unless DSH_HOME canonicalizes inside here.
    await install()
    expect(fs.existsSync(dshHomeFor(dataRoot))).toBe(true)
  })

  it("records digests that match what is on disk", async () => {
    const channel = await install()
    expect(channel.compositionDigest).toBe(computeCompositionDigest(runtimeHomeFor(dataRoot)))
    expect(channel.lockfileDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("derives the channel id from the composition digest", async () => {
    const channel = await install()
    expect(channel.channelId).toContain(channel.compositionDigest.slice(0, 8))
  })

  it("refuses to install when a source artifact is missing", async () => {
    fs.rmSync(path.join(sourceDir, "launcher.mjs"))
    await expect(install()).rejects.toThrow(DshInstallError)
  })

  it("leaves the previous runtime intact when npm fails", async () => {
    // A failed upgrade must not strand the user with no runtime at all.
    const first = await install()
    await expect(
      install({
        runNpmInstall: async () => {
          throw new Error("network down")
        },
      })
    ).rejects.toThrow(/previous runtime was left in place/)

    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "utf8")
    )
    expect(manifest.channelId).toBe(first.channelId)
  })

  it("leaves no staging directory behind after a failure", async () => {
    await expect(
      install({
        runNpmInstall: async () => {
          throw new Error("boom")
        },
      })
    ).rejects.toThrow(DshInstallError)
    expect(fs.existsSync(`${runtimeHomeFor(dataRoot)}.staging`)).toBe(false)
  })

  it("refuses to certify an install that produced no lockfile", async () => {
    // The lockfile digest is the dependency identity; without it nothing is pinned.
    await expect(install({ runNpmInstall: async () => {} })).rejects.toThrow(/no package-lock/)
  })

  it("replaces an existing install and leaves no .previous directory", async () => {
    await install()
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "# v2\n")
    const second = await install()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "utf8")
    )
    expect(manifest.channelId).toBe(second.channelId)
    expect(fs.existsSync(`${runtimeHomeFor(dataRoot)}.previous`)).toBe(false)
  })

  it("reports progress without echoing credentials", async () => {
    const lines: string[] = []
    await install({ onProgress: (line) => lines.push(line) })
    expect(lines.join("\n")).toContain("Installed channel")
    expect(lines.join("\n")).not.toMatch(/sk-/)
  })
})

describe("findStrayPatchLayers", () => {
  it("finds nothing in a clean home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"))
    expect(findStrayPatchLayers(home)).toEqual([])
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("finds a home-level patch file", async () => {
    await install()
    const home = dshHomeFor(dataRoot)
    const patch = path.join(home, "cordis.patch.yml")
    fs.writeFileSync(patch, "- id: evil\n")
    expect(findStrayPatchLayers(home)).toEqual([patch])
  })

  it("finds per-profile patch files and out-of-tree plugin manifests", async () => {
    // A profile package.json declares out-of-tree plugin dependencies, which is
    // just as much a hole in the certification as a patch file.
    await install()
    const home = dshHomeFor(dataRoot)
    const profile = path.join(home, "profiles", "sneaky")
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "")
    fs.writeFileSync(path.join(profile, "package.json"), "{}")
    expect(findStrayPatchLayers(home)).toHaveLength(2)
  })

  it("ignores files that are not patch layers", async () => {
    await install()
    const home = dshHomeFor(dataRoot)
    fs.writeFileSync(path.join(home, "notes.txt"), "hello")
    expect(findStrayPatchLayers(home)).toEqual([])
  })
})

describe("doctorInstalledDshRuntime", () => {
  it("reports an uninstalled runtime rather than throwing", () => {
    const report = doctorInstalledDshRuntime({ dataRoot, profileId: "cognia-sdk-readonly" })
    expect(report.healthy).toBe(false)
    expect(report.findings[0].code).toBe("channel-malformed")
  })

  it("reports healthy immediately after install", async () => {
    await install()
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report).toEqual({ healthy: true, findings: [] })
  })

  it("detects a tampered composition", async () => {
    // The composition carries the sandbox and approval wiring, so this is the
    // check that makes the read-only guarantee meaningful.
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), "host.sdk-readonly.yml"), "# tampered\n")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("composition-digest-mismatch")
  })

  it("detects a tampered lockfile", async () => {
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), "package-lock.json"), "{}")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.findings.map((f) => f.code)).toContain("lockfile-digest-mismatch")
  })

  it("treats a stray patch layer as fatal on the read-only profile", async () => {
    await install()
    fs.writeFileSync(path.join(dshHomeFor(dataRoot), "cordis.patch.yml"), "- id: evil\n")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("stray-patch-layer")
  })

  it("reports a malformed manifest instead of crashing", async () => {
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "{not json")
    const report = doctorInstalledDshRuntime({ dataRoot, profileId: "cognia-sdk-readonly" })
    expect(report.healthy).toBe(false)
    expect(report.findings[0].code).toBe("channel-malformed")
  })

  it("reports an unreadable digest as a mismatch rather than throwing", async () => {
    await install()
    fs.rmSync(path.join(runtimeHomeFor(dataRoot), "package-lock.json"))
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.findings.map((f) => f.code)).toContain("lockfile-digest-mismatch")
  })
})

describe("removeDshRuntime", () => {
  it("removes the runtime home", async () => {
    await install()
    removeDshRuntime({ dataRoot })
    expect(fs.existsSync(runtimeHomeFor(dataRoot))).toBe(false)
  })

  it("refuses while sessions are still using it", async () => {
    // Removing under a live session would strand a running subprocess whose
    // composition had just been deleted.
    await install()
    expect(() => removeDshRuntime({ dataRoot, activeSessionCount: 2 })).toThrow(DshInstallError)
    expect(fs.existsSync(runtimeHomeFor(dataRoot))).toBe(true)
  })

  it("is idempotent when nothing is installed", () => {
    expect(() => removeDshRuntime({ dataRoot })).not.toThrow()
  })
})
