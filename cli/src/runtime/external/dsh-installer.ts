import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  DshDoctorReport,
  DshInstalledRuntimeFacts,
} from "@/lib/ai/agent/external/dsh-runtime-install"
import {
  buildDshChannelManifest,
  doctorDshRuntime,
  dshPlatformKey,
} from "@/lib/ai/agent/external/dsh-runtime-install"
import type { DshProfileId, DshRuntimeChannel } from "@/types/agent/dsh-runtime-channel"

/**
 * Installs the Cognia-owned DeepSeek Harness runtime into an isolated home.
 *
 * The verdict logic lives in `lib/ai/agent/external/dsh-runtime-install.ts` and
 * is pure; this module is only the IO that gathers facts for it and moves bytes.
 * Keeping the split means the Tauri and headless paths cannot drift on what
 * counts as a healthy install.
 *
 * Nothing here touches the user's project: no `package.json` is modified, no
 * dependency is added to the Cognia workspace, and `npx -y` is never used at
 * execution time.
 */

/** Files copied from `runtime/deepseek-harness/` into the runtime home. */
export const RUNTIME_ARTIFACTS = [
  "package.json",
  "launcher.mjs",
  "host.sdk-readonly.yml",
  "host.sdk-workspace.yml",
  "host.acp.yml",
] as const

/** Files whose bytes make up the composition digest, in a stable order. */
const COMPOSITION_DIGEST_FILES = [
  "launcher.mjs",
  "host.sdk-readonly.yml",
  "host.sdk-workspace.yml",
  "host.acp.yml",
] as const

export const CHANNEL_MANIFEST_FILE = "cognia-channel.json"
export const UPSTREAM_VERSION = "0.1.0-rc.6"
export const NODE_MAJOR_REQUIRED = 26 as const
export const CONFORMANCE_SUITE_VERSION = "1"

export interface DshInstallPaths {
  /** Cognia data root, e.g. `~/.cognia`. */
  dataRoot: string
  /** Source directory holding the artifacts (repo `runtime/deepseek-harness/`). */
  sourceDir: string
}

export function runtimeHomeFor(dataRoot: string): string {
  return path.join(dataRoot, "deepseek-harness")
}

export function dshHomeFor(dataRoot: string): string {
  // Inside the runtime home, which is what the launcher's containment check
  // requires. DSH's own default (~/.dsh) would be user-writable.
  return path.join(runtimeHomeFor(dataRoot), "dsh-home")
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Digest over the composition and launcher bytes.
 *
 * Each file contributes its name and length as well as its content, so moving
 * bytes between two files cannot produce the same digest.
 */
export function computeCompositionDigest(dir: string): string {
  const hash = createHash("sha256")
  for (const name of COMPOSITION_DIGEST_FILES) {
    const content = fs.readFileSync(path.join(dir, name))
    hash.update(name).update("\0").update(String(content.length)).update("\0").update(content)
  }
  return hash.digest("hex")
}

export function computeLockfileDigest(runtimeHome: string): string {
  return sha256(fs.readFileSync(path.join(runtimeHome, "package-lock.json")))
}

export interface InstallOptions extends DshInstallPaths {
  /** Emits progress lines. Never receives credential material. */
  onProgress?: (line: string) => void
  /** Overridable for tests; defaults to spawning real npm. */
  runNpmInstall?: (cwd: string) => Promise<void>
}

export class DshInstallError extends Error {}

/**
 * Install or reinstall the runtime.
 *
 * Atomic in the sense that matters: the new tree is built beside the live one
 * and swapped in only after `npm install` succeeds, so a failed install leaves
 * the previously certified runtime untouched.
 */
export async function installDshRuntime(options: InstallOptions): Promise<DshRuntimeChannel> {
  const { dataRoot, sourceDir, onProgress } = options
  const runtimeHome = runtimeHomeFor(dataRoot)
  const staging = `${runtimeHome}.staging`
  const previous = `${runtimeHome}.previous`

  for (const artifact of RUNTIME_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, artifact))) {
      throw new DshInstallError(`Runtime artifact missing from source: ${artifact}`)
    }
  }

  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  for (const artifact of RUNTIME_ARTIFACTS) {
    fs.copyFileSync(path.join(sourceDir, artifact), path.join(staging, artifact))
  }
  // Created up front so the launcher's containment check has a real directory
  // to canonicalize rather than falling back to a lexical path.
  fs.mkdirSync(path.join(staging, "dsh-home"), { recursive: true })

  onProgress?.("Installing DeepSeek Harness packages…")
  const runNpmInstall = options.runNpmInstall ?? defaultNpmInstall
  try {
    await runNpmInstall(staging)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new DshInstallError(
      `npm install failed; the previous runtime was left in place. ${(error as Error).message}`
    )
  }

  if (!fs.existsSync(path.join(staging, "package-lock.json"))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new DshInstallError("npm install produced no package-lock.json; refusing to certify.")
  }

  const channel = buildDshChannelManifest({
    lockfileDigest: computeLockfileDigest(staging),
    compositionDigest: computeCompositionDigest(staging),
  })
  fs.writeFileSync(
    path.join(staging, CHANNEL_MANIFEST_FILE),
    `${JSON.stringify(channel, null, 2)}\n`
  )

  // Swap last: until this point the live runtime is still the old one.
  fs.rmSync(previous, { recursive: true, force: true })
  if (fs.existsSync(runtimeHome)) fs.renameSync(runtimeHome, previous)
  fs.renameSync(staging, runtimeHome)
  fs.rmSync(previous, { recursive: true, force: true })

  onProgress?.(`Installed channel ${channel.channelId}`)
  return channel
}

async function defaultNpmInstall(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "install",
        // koffi is a hard dependency of dsh-fs-local but is imported only from a
        // Windows-only code path, so it is installed and never built. Skipping
        // scripts also removes an arbitrary-code-execution step from install.
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock-only=false",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

/**
 * Paths under `DSH_HOME` that DSH would apply as user patch layers.
 *
 * These apply after every bundle layer and may run arbitrary JavaScript through
 * the `!!js` YAML tag, so their presence means the composition digest no longer
 * describes what will actually be mounted.
 */
export function findStrayPatchLayers(dshHome: string): string[] {
  const found: string[] = []
  const homePatch = path.join(dshHome, "cordis.patch.yml")
  if (fs.existsSync(homePatch)) found.push(homePatch)

  const profilesDir = path.join(dshHome, "profiles")
  if (fs.existsSync(profilesDir)) {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const name of ["cordis.patch.yml", "package.json"]) {
        const candidate = path.join(profilesDir, entry.name, name)
        if (fs.existsSync(candidate)) found.push(candidate)
      }
    }
  }
  return found
}

/** Whether a C/C++ toolchain is present, for profiles needing a node-pty build. */
export function hasNativeToolchain(): boolean {
  return ["cc", "gcc", "clang"].some((binary) =>
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .some((dir) => dir && fs.existsSync(path.join(dir, binary)))
  )
}

export interface DoctorOptions extends Pick<DshInstallPaths, "dataRoot"> {
  profileId: DshProfileId
  nodeVersion?: string
  platform?: string
}

/** Gather facts from disk and hand them to the pure verdict function. */
export function doctorInstalledDshRuntime(options: DoctorOptions): DshDoctorReport {
  const runtimeHome = runtimeHomeFor(options.dataRoot)
  const manifestPath = path.join(runtimeHome, CHANNEL_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    return {
      healthy: false,
      findings: [
        {
          code: "channel-malformed",
          severity: "error",
          detail: "no runtime is installed",
        },
      ],
    }
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return {
      healthy: false,
      findings: [
        { code: "channel-malformed", severity: "error", detail: (error as Error).message },
      ],
    }
  }

  const facts: DshInstalledRuntimeFacts = {
    lockfileDigest: safe(() => computeLockfileDigest(runtimeHome)),
    compositionDigest: safe(() => computeCompositionDigest(runtimeHome)),
    nodeVersion: options.nodeVersion ?? process.version,
    platform: options.platform ?? dshPlatformKey(process.platform, process.arch),
    strayPatchPaths: findStrayPatchLayers(path.join(runtimeHome, "dsh-home")),
    hasNativeToolchain: hasNativeToolchain(),
  }
  return doctorDshRuntime(manifest, facts, options.profileId)
}

/** A missing or unreadable file yields a digest that cannot match, never a throw. */
function safe(compute: () => string): string {
  try {
    return compute()
  } catch {
    return "unreadable"
  }
}

export interface RemoveOptions extends Pick<DshInstallPaths, "dataRoot"> {
  /** Sessions still using the runtime; removal is refused while any is live. */
  activeSessionCount?: number
}

export function removeDshRuntime(options: RemoveOptions): void {
  if ((options.activeSessionCount ?? 0) > 0) {
    throw new DshInstallError(
      `Refusing to remove the runtime while ${options.activeSessionCount} session(s) are still using it.`
    )
  }
  const runtimeHome = runtimeHomeFor(options.dataRoot)
  fs.rmSync(runtimeHome, { recursive: true, force: true })
  fs.rmSync(`${runtimeHome}.staging`, { recursive: true, force: true })
  fs.rmSync(`${runtimeHome}.previous`, { recursive: true, force: true })
}

/** Default Cognia data root, matching the CLI's `~/.cognia` convention. */
export function defaultDataRoot(): string {
  return path.join(os.homedir(), ".cognia")
}

// ── Host surface shared with the Tauri commands ──────────────────────────────
//
// `dsh_runtime_facts` / `dsh_runtime_install` / `dsh_runtime_finalize` /
// `dsh_runtime_remove` exist in both hosts with the same shapes, so the
// renderer runs one flow everywhere and the verdict is always rendered by the
// shared `doctorDshRuntime()`.

export interface DshInstallDigests {
  lockfileDigest: string
  compositionDigest: string
}

/** Gather install facts; never throws, so a broken install stays diagnosable. */
export function gatherDshRuntimeFacts(dataRoot: string): {
  manifestJson: string | null
  lockfileDigest: string
  compositionDigest: string
  nodeVersion: string
  platform: string
  strayPatchPaths: string[]
  hasNativeToolchain: boolean
} {
  const home = runtimeHomeFor(dataRoot)
  let manifestJson: string | null = null
  try {
    manifestJson = fs.readFileSync(path.join(home, CHANNEL_MANIFEST_FILE), "utf8")
  } catch {
    manifestJson = null
  }
  return {
    manifestJson,
    // "unreadable" can never equal a certified digest, so the verdict function
    // reports a mismatch rather than the whole check throwing.
    lockfileDigest: safe(() => computeLockfileDigest(home)),
    compositionDigest: safe(() => computeCompositionDigest(home)),
    nodeVersion: process.version,
    platform: dshPlatformKey(process.platform, process.arch),
    strayPatchPaths: findStrayPatchLayers(dshHomeFor(dataRoot)),
    hasNativeToolchain: hasNativeToolchain(),
  }
}

/**
 * Stage a runtime and install its dependencies, returning the digests.
 *
 * The live runtime is untouched until {@link finalizeDshInstall}.
 */
export async function stageDshInstall(
  options: DshInstallPaths & { runNpmInstall?: (cwd: string) => Promise<void> }
): Promise<DshInstallDigests> {
  const { dataRoot, sourceDir } = options
  const staging = `${runtimeHomeFor(dataRoot)}.staging`

  for (const artifact of RUNTIME_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, artifact))) {
      throw new DshInstallError(`Runtime artifact missing from source: ${artifact}`)
    }
  }

  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  for (const artifact of RUNTIME_ARTIFACTS) {
    fs.copyFileSync(path.join(sourceDir, artifact), path.join(staging, artifact))
  }
  fs.mkdirSync(path.join(staging, "dsh-home"), { recursive: true })

  try {
    await (options.runNpmInstall ?? defaultNpmInstall)(staging)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new DshInstallError(
      `npm install failed; the previous runtime was left in place. ${(error as Error).message}`
    )
  }
  if (!fs.existsSync(path.join(staging, "package-lock.json"))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new DshInstallError("npm install produced no package-lock.json; refusing to certify.")
  }

  return {
    lockfileDigest: computeLockfileDigest(staging),
    compositionDigest: computeCompositionDigest(staging),
  }
}

/** Write the renderer-built manifest and activate the staged runtime. */
export function finalizeDshInstall(dataRoot: string, manifestJson: string): void {
  const home = runtimeHomeFor(dataRoot)
  const staging = `${home}.staging`
  const previous = `${home}.previous`
  if (!fs.existsSync(staging)) {
    throw new DshInstallError("No staged runtime to finalize.")
  }
  fs.writeFileSync(path.join(staging, CHANNEL_MANIFEST_FILE), manifestJson)

  fs.rmSync(previous, { recursive: true, force: true })
  if (fs.existsSync(home)) fs.renameSync(home, previous)
  try {
    fs.renameSync(staging, home)
  } catch (error) {
    // Put the old runtime back rather than leaving the user with none.
    if (fs.existsSync(previous)) fs.renameSync(previous, home)
    throw new DshInstallError(`Cannot activate staged runtime: ${(error as Error).message}`)
  }
  fs.rmSync(previous, { recursive: true, force: true })
}
