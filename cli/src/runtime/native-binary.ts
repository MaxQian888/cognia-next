/**
 * Where the CLI looks for the native helpers it ships alongside itself.
 *
 * Two helpers now need the same answer: `cognia-external-agent-launcher`, which
 * confines an external agent process, and `cognia-sandbox-exec`, which runs one
 * confined command for the OS sandbox tier. Both are built from
 * `crates/cognia-automation`, both land in the same places, and both have to be
 * findable from a packaged single-file bundle, a split `chunks/` bundle, an
 * installed CLI, and a repo checkout.
 *
 * The lookup lived inside `sandbox-launcher.ts` as private helpers. It is here
 * so the second helper reuses it rather than growing a near-copy that drifts on
 * the day someone adds a search location to one of them.
 *
 * Resolution is by executability, not existence: a non-executable file at the
 * expected path is the same failure as a missing one, and treating it as found
 * would surface as a spawn error much later.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Platform-correct filename. `platform` is a parameter so the Windows spelling
 * is reachable from a test on any host. */
export function nativeBinaryName(
  base: string,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? `${base}.exe` : base
}

/** Locations inside the shipped bundle, covering both single-file and `chunks/` layouts. */
export function bundledCandidates(moduleUrl: string, name: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl))
  return [path.join(moduleDir, name), path.join(moduleDir, "..", name)]
}

export function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface NativeCandidateOptions {
  /** Base name without the platform extension, e.g. `cognia-sandbox-exec`. */
  base: string
  /** Env var an operator can point at a built binary. Checked first. */
  envVar: string
  /** `import.meta.url` of the calling module, for the bundled locations. */
  moduleUrl: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  execPath?: string
  cwd?: string
}

/**
 * The ordered search path. The env override wins so an operator can point at a
 * freshly built binary without reinstalling. The repo `target/` entries come
 * last so a stale debug build never shadows a shipped one.
 */
export function defaultNativeCandidates(options: NativeCandidateOptions): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const execPath = options.execPath ?? process.execPath
  const cwd = options.cwd ?? process.cwd()
  const name = nativeBinaryName(options.base, platform)
  return [
    env[options.envVar],
    ...bundledCandidates(options.moduleUrl, name),
    path.join(path.dirname(execPath), name),
    path.join(cwd, "cli", "dist", "native", `${platform}-${arch}`, name),
    path.join(cwd, "target", "release", name),
    path.join(cwd, "target", "debug", name),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

/** The first executable candidate, or `undefined` when none is usable. */
export function findNativeBinary(
  candidates: readonly string[],
  executable: (candidate: string) => boolean = isExecutable
): string | undefined {
  return candidates.find(executable)
}

/** Is this an in-repo checkout, where a build command is a real remedy rather
 * than noise to whoever is running an installed CLI? */
export function isDevCheckout(cwd: string = process.cwd()): boolean {
  try {
    return fs.existsSync(path.join(cwd, "cli", "package.json"))
  } catch {
    return false
  }
}
