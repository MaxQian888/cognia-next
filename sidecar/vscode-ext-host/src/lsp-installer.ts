/**
 * LSP binary resolution + npm-first install ladder.
 *
 * Both LSP consumers share this module: the editor pathway calls it through
 * `LspService.detect()` / `.install()` (renderer drives via the new
 * `lsp:detect` / `lsp:install` RPCs), and the agent runtime calls it through
 * `sidecar/lsp/resolver.mjs`'s `ensureCommand` seam (dynamic import of the
 * compiled `dist/lsp-installer.js`).
 *
 * Resolution ladder (first hit wins):
 *   1. Explicit path — `command` containing a path separator is trusted as-is
 *      (exists → installed, else missing; an explicit path is never
 *      auto-installed over).
 *   2. Project `node_modules/.bin/<command>` walking up from `projectRoot`.
 *   3. Managed dir — `<installDir>/node/<npm-package>/node_modules/.bin/`.
 *   4. PATH probe (PATHEXT-aware on Windows).
 *   5. `npm install <pkg> --prefix <managed dir>` when the entry declares an
 *      `npmPackage`, installs are allowed, and the kill-switch is off — then
 *      re-resolve rung 3.
 *
 * The managed dir is keyed by PACKAGE, not server id: one package can ship
 * several binaries (`vscode-langservers-extracted` → json/css/html/eslint),
 * so keying by id would install the same tarball four times.
 *
 * Kill-switch: the `COGNIA_DISABLE_LSP_DOWNLOAD` env var (mirrors OpenCode's
 * `OPENCODE_DISABLE_LSP_DOWNLOAD`) hard-disables rung 5 regardless of the
 * caller's `allowInstall`.
 *
 * Everything is dependency-injected (fs probes, npm runner, env) so the
 * `node --test` suite exercises every rung without touching the filesystem
 * or spawning processes.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs = require("node:fs") as typeof import("node:fs")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require("node:path") as typeof import("node:path")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeChildProcess = require("node:child_process") as typeof import("node:child_process")

export type LspInstallSource = "explicit" | "project" | "managed" | "path"

export interface ResolveBinaryInput {
  /** Binary name (`typescript-language-server`) or explicit path. */
  command: string
  /** npm package that ships the binary — enables rungs 3 and 5. */
  npmPackage?: string
  /** Pinned version/range for rung 5. Defaults to `latest`. */
  version?: string
  /** Workspace root to walk up from for rung 2. */
  projectRoot?: string
  /** Managed install root (`<appData>/lsp`) for rungs 3 and 5. */
  installDir?: string
  /** Permit rung 5. Default false — detection only. */
  allowInstall?: boolean
  /** Install progress sink (rung 5 only). */
  onProgress?: (progress: LspInstallProgress) => void
}

export interface ResolveBinaryResult {
  status: "installed" | "managed" | "missing"
  source: LspInstallSource | null
  resolvedPath: string | null
  /** Failure detail when an attempted install left the binary missing. */
  error?: string
}

export interface LspInstallProgress {
  phase: "resolving" | "installing" | "done" | "error"
  message?: string
}

export interface InstallNpmServerInput {
  npmPackage: string
  version?: string
  installDir: string
  onProgress?: (progress: LspInstallProgress) => void
}

/** Injectable seams — production defaults hit the real fs / npm. */
export interface LspInstallerDeps {
  existsSync?: (p: string) => boolean
  mkdirSync?: (p: string, opts?: { recursive?: boolean }) => void
  writeFileSync?: (p: string, content: string) => void
  rmdirSync?: (p: string) => void
  /** Runs `npm <args>` to completion. Resolves on exit 0, rejects otherwise. */
  runNpm?: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<void>
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  /** Millisecond sleeper for the lock retry loop. */
  delay?: (ms: number) => Promise<void>
}

const NPM_INSTALL_TIMEOUT_MS = 300_000
const LOCK_RETRY_MS = 250
const LOCK_TIMEOUT_MS = 60_000
/** Walk-up bound for the project node_modules probe. */
const MAX_PROJECT_WALK = 30

export function isDownloadDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.COGNIA_DISABLE_LSP_DOWNLOAD
  return v === "1" || v === "true"
}

/** `@scope/pkg` → `@scope__pkg` so the package keys a single directory. */
function sanitizePackageDir(npmPackage: string): string {
  return npmPackage.replace(/\//g, "__")
}

export function managedPackageDir(installDir: string, npmPackage: string): string {
  return nodePath.join(installDir, "node", sanitizePackageDir(npmPackage))
}

export function createLspInstaller(deps: LspInstallerDeps = {}) {
  const existsSync = deps.existsSync ?? nodeFs.existsSync
  const mkdirSync = deps.mkdirSync ?? nodeFs.mkdirSync
  const writeFileSync = deps.writeFileSync ?? nodeFs.writeFileSync
  const rmdirSync = deps.rmdirSync ?? nodeFs.rmdirSync
  const runNpm = deps.runNpm ?? defaultRunNpm
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const isWindows = platform === "win32"

  /** Candidate file names for a bin inside a `.bin` dir (or PATH dir). */
  function binCandidates(dir: string, command: string): string[] {
    if (!isWindows) return [nodePath.join(dir, command)]
    const exts = (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    // `.bin` shims on Windows are `.cmd` first; keep the bare name last so a
    // real extensionless executable still resolves.
    return [
      ...exts.map((ext) => nodePath.join(dir, command + ext.toLowerCase())),
      ...exts.map((ext) => nodePath.join(dir, command + ext)),
      nodePath.join(dir, command),
    ]
  }

  function firstExisting(candidates: string[]): string | null {
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* probe errors count as absent */
      }
    }
    return null
  }

  /** Rung 2 — project `node_modules/.bin`, walking up from `projectRoot`. */
  function resolveFromProject(command: string, projectRoot: string): string | null {
    let dir = nodePath.resolve(projectRoot)
    for (let i = 0; i < MAX_PROJECT_WALK; i++) {
      const hit = firstExisting(binCandidates(nodePath.join(dir, "node_modules", ".bin"), command))
      if (hit) return hit
      const parent = nodePath.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  /** Rung 3 — managed `<installDir>/node/<pkg>/node_modules/.bin`. */
  function resolveFromManaged(
    command: string,
    installDir: string,
    npmPackage: string
  ): string | null {
    const binDir = nodePath.join(managedPackageDir(installDir, npmPackage), "node_modules", ".bin")
    return firstExisting(binCandidates(binDir, command))
  }

  /** Rung 4 — PATH probe (PATHEXT-aware). */
  function resolveFromPath(command: string): string | null {
    const envPath = env.PATH || env.Path || ""
    for (const dir of envPath.split(nodePath.delimiter).filter(Boolean)) {
      const hit = firstExisting(binCandidates(dir, command))
      if (hit) return hit
    }
    return null
  }

  async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = nodePath.join(dir, ".install-lock")
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    // mkdir is atomic — first creator owns the lock; others poll until it
    // disappears or the deadline passes (a stale lock then gets stolen).
    for (;;) {
      try {
        mkdirSync(lockDir)
        break
      } catch {
        if (Date.now() > deadline) break // steal a stale lock
        await delay(LOCK_RETRY_MS)
      }
    }
    try {
      return await fn()
    } finally {
      try {
        rmdirSync(lockDir)
      } catch {
        /* already gone */
      }
    }
  }

  /** Rung 5 — npm install into the managed dir. Throws on failure. */
  async function installNpmServer(input: InstallNpmServerInput): Promise<void> {
    const dir = managedPackageDir(input.installDir, input.npmPackage)
    input.onProgress?.({ phase: "resolving", message: input.npmPackage })
    mkdirSync(dir, { recursive: true })
    await withLock(dir, async () => {
      const manifest = nodePath.join(dir, "package.json")
      if (!existsSync(manifest)) {
        writeFileSync(
          manifest,
          JSON.stringify({ name: "cognia-lsp-managed", private: true }, null, 2)
        )
      }
      const spec = `${input.npmPackage}@${input.version ?? "latest"}`
      input.onProgress?.({ phase: "installing", message: spec })
      await runNpm(
        ["install", spec, "--prefix", dir, "--no-audit", "--no-fund", "--loglevel=error"],
        { cwd: dir, timeoutMs: NPM_INSTALL_TIMEOUT_MS }
      )
    })
    input.onProgress?.({ phase: "done" })
  }

  /** The full ladder. Never throws — failures land in `status: "missing"`. */
  async function resolveBinary(input: ResolveBinaryInput): Promise<ResolveBinaryResult> {
    const { command } = input
    if (!command) return { status: "missing", source: null, resolvedPath: null }

    // 1. Explicit path — trusted verbatim, never installed over.
    if (command.includes("/") || command.includes(nodePath.sep)) {
      return existsSync(command)
        ? { status: "installed", source: "explicit", resolvedPath: command }
        : { status: "missing", source: null, resolvedPath: null }
    }

    // 2. Project node_modules/.bin.
    if (input.projectRoot) {
      const hit = resolveFromProject(command, input.projectRoot)
      if (hit) return { status: "installed", source: "project", resolvedPath: hit }
    }

    // 3. Managed dir.
    if (input.installDir && input.npmPackage) {
      const hit = resolveFromManaged(command, input.installDir, input.npmPackage)
      if (hit) return { status: "managed", source: "managed", resolvedPath: hit }
    }

    // 4. PATH.
    {
      const hit = resolveFromPath(command)
      if (hit) return { status: "installed", source: "path", resolvedPath: hit }
    }

    // 5. npm install, then re-resolve the managed dir.
    if (input.npmPackage && input.installDir && input.allowInstall && !isDownloadDisabled(env)) {
      try {
        await installNpmServer({
          npmPackage: input.npmPackage,
          version: input.version,
          installDir: input.installDir,
          onProgress: input.onProgress,
        })
        const hit = resolveFromManaged(command, input.installDir, input.npmPackage)
        if (hit) return { status: "managed", source: "managed", resolvedPath: hit }
        return {
          status: "missing",
          source: null,
          resolvedPath: null,
          error: `npm install succeeded but '${command}' is absent from the package bin`,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        input.onProgress?.({ phase: "error", message })
        return { status: "missing", source: null, resolvedPath: null, error: message }
      }
    }

    return { status: "missing", source: null, resolvedPath: null }
  }

  /** Production npm runner — locates npm on PATH, spawns, enforces a timeout. */
  function defaultRunNpm(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<void> {
    const npmBin = resolveFromPath(isWindows ? "npm" : "npm")
    if (!npmBin) return Promise.reject(new Error("npm not found on PATH — cannot auto-install"))
    return new Promise<void>((resolve, reject) => {
      // `.cmd` shims need a shell on Windows (Node ≥ 20 refuses otherwise).
      const child = nodeChildProcess.spawn(npmBin, args, {
        cwd: opts.cwd,
        shell: isWindows,
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (buf: Buffer) => {
        stderr = (stderr + buf.toString("utf-8")).slice(-4096)
      })
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* swallow */
        }
        reject(new Error(`npm install timed out after ${opts.timeoutMs}ms`))
      }, opts.timeoutMs)
      child.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on("exit", (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`npm install exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
      })
    })
  }

  return { resolveBinary, installNpmServer, isDownloadDisabled: () => isDownloadDisabled(env) }
}

export type LspInstaller = ReturnType<typeof createLspInstaller>
