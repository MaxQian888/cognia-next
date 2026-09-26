// Lazily import the COMPILED LspService from the vscode-ext-host sidecar
// and wire a per-agent-session resolver to it.
//
// Reuse-first: the agent sidecar does not reimplement the LSP client or
// its lifecycle. It imports the already-built `LspService` (CommonJS) via
// ESM interop and feeds its `LspNotificationSink` into the resolver's
// diagnostics cache. `vscode-jsonrpc` resolves from vscode-ext-host's own
// node_modules, so nothing is added to this package's dependencies.
//
// The import is dynamic + cached so non-coding sessions never load it,
// and a build-missing dist degrades to "LSP unavailable" instead of a
// hard crash.

import path from "node:path"
import { createLspResolver } from "./resolver.ts"
import type {
  EnsureCommand,
  LspLogger,
  LspResolver,
  LspServiceLike,
  PublishDiagnosticsParams,
} from "./resolver.ts"
import {
  execFileAsync,
  sandboxedProcessTarget,
  sandboxedProcessEnv,
} from "../../platform/process/exec.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import { sidecarPath } from "../../platform/sidecar-paths.ts"

/** The compiled `LspService` class: notifications flow into `sink`. */
type LspServiceCtor = new (
  sink: (method: string, params: unknown) => void,
  logger: LspLogger
) => LspServiceLike

/** The compiled installer's npm-first binary ladder. */
interface LspInstaller {
  resolveBinary(request: {
    command: string
    npmPackage?: string | undefined
    version?: string | undefined
    projectRoot?: string | undefined
    installDir?: string | undefined
    allowInstall: boolean
  }): Promise<{ status: string; resolvedPath: string | null; error?: string }>
}

type CreateLspInstaller = (options: {
  runNpm?: (args: string[], runOptions: { cwd: string; timeoutMs?: number }) => Promise<void>
}) => LspInstaller

/** A sandbox scope that must name its writable roots (the installer widens them). */
type InstallSandbox = ProcessSandboxScope & { writableRoots: readonly string[] }

export interface SessionLspOptions {
  cwd: string
  servers?: unknown
  installDir?: string | undefined
  allowInstall?: boolean
  logger?: LspLogger | undefined
  ensureCommand?: EnsureCommand | undefined
  builtinProcessSandbox?: InstallSandbox | undefined
}

// The extension host sits beside the sidecar root in the source tree, and
// beside the bundle when a bundler flattened this module into it.
const LSP_HOST_DIR = sidecarPath("vscode-ext-host")
const LSP_SERVICE_PATH = path.join(LSP_HOST_DIR, "dist/lsp-service.js")
const LSP_INSTALLER_PATH = path.join(LSP_HOST_DIR, "dist/lsp-installer.js")

/**
 * Hard ceiling for a binary resolution inside an agent turn. The npm install
 * itself may take minutes — when it exceeds this budget the turn proceeds
 * without the server (the install keeps running detached and the binary is
 * picked up from the managed dir on a later touch).
 */
const ENSURE_COMMAND_TURN_BUDGET_MS = 30_000

let lspServiceCtorPromise: Promise<LspServiceCtor> | null = null

/** Dynamically import the compiled `LspService` constructor (cached). */
export async function loadLspServiceCtor(): Promise<LspServiceCtor> {
  if (!lspServiceCtorPromise) {
    lspServiceCtorPromise = (async () => {
      const mod = (await import(pathToImportUrl(LSP_SERVICE_PATH))) as {
        LspService?: unknown
        default?: { LspService?: unknown } | undefined
      }
      const Ctor = mod.LspService ?? mod.default?.LspService ?? mod.default
      if (typeof Ctor !== "function") {
        throw new Error("LspService not found in compiled vscode-ext-host bundle")
      }
      return Ctor as LspServiceCtor
    })()
  }
  return lspServiceCtorPromise
}

function pathToImportUrl(p: string): string {
  // On Windows a bare path import must be a file:// URL.
  return process.platform === "win32" ? `file://${p.replace(/\\/g, "/")}` : p
}

/**
 * Build the installer-backed `ensureCommand` (npm-first ladder: explicit →
 * project node_modules/.bin → managed dir → PATH → npm install). Returns
 * `null` when the compiled installer is unavailable so the resolver falls
 * back to its built-in PATH probe.
 */
async function makeInstallerEnsureCommand(opts: SessionLspOptions): Promise<EnsureCommand | null> {
  let installer: LspInstaller
  try {
    const mod = (await import(pathToImportUrl(LSP_INSTALLER_PATH))) as {
      createLspInstaller?: unknown
      default?: { createLspInstaller?: unknown } | undefined
    }
    const createLspInstaller = mod.createLspInstaller ?? mod.default?.createLspInstaller
    if (typeof createLspInstaller !== "function") return null
    const sandbox = opts.builtinProcessSandbox
    installer = (createLspInstaller as CreateLspInstaller)(
      sandbox
        ? {
            runNpm: async (args, runOptions) => {
              if (sandbox.network !== true)
                throw new Error("LSP installation requires network permission")
              const scope = {
                ...sandbox,
                writableRoots: [...sandbox.writableRoots, opts.installDir as string],
              }
              const target = sandboxedProcessTarget("npm", args, runOptions.cwd, scope)
              await execFileAsync(target.command, target.args, {
                cwd: runOptions.cwd,
                timeout: runOptions.timeoutMs,
                env: sandboxedProcessEnv(process.env, scope),
              })
            },
          }
        : {}
    )
  } catch {
    return null
  }
  return async (command, ctx) => {
    const ladder = installer
      .resolveBinary({
        command,
        npmPackage: ctx.install?.npmPackage,
        version: ctx.install?.version,
        projectRoot: ctx.root,
        installDir: opts.installDir,
        allowInstall: opts.allowInstall === true && !!opts.installDir,
      })
      .then((res) => {
        if (res.status === "missing" && res.error) {
          opts.logger?.warn?.(`[lsp] install failed for ${command}: ${res.error}`)
        }
        return res.resolvedPath
      })
    // Never let a slow install hold an agent turn hostage.
    const budget = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), ENSURE_COMMAND_TURN_BUDGET_MS)
    )
    return Promise.race([ladder, budget])
  }
}

/**
 * Create a resolver backed by a real per-session LspService. Returns
 * `null` when the LSP host can't be loaded (e.g. dist not built / mobile)
 * so callers can no-op gracefully.
 */
export async function createSessionLspResolver(
  opts: SessionLspOptions
): Promise<LspResolver | null> {
  let LspService: LspServiceCtor
  try {
    LspService = await loadLspServiceCtor()
  } catch (err) {
    opts.logger?.warn?.("[lsp] LSP host unavailable — diagnostics disabled", {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Forward `lsp:publishDiagnostics` notifications into the resolver cache.
  let resolverRef: LspResolver | null = null
  const service = new LspService((method, params) => {
    if (method === "lsp:publishDiagnostics")
      resolverRef?.ingestDiagnostics(params as PublishDiagnosticsParams)
  }, opts.logger ?? {})

  const ensureCommand = opts.ensureCommand ?? (await makeInstallerEnsureCommand(opts)) ?? undefined

  const resolver = createLspResolver({
    service,
    cwd: opts.cwd,
    servers: opts.servers,
    ensureCommand,
    logger: opts.logger,
    builtinProcessSandbox: opts.builtinProcessSandbox,
  })
  resolverRef = resolver
  return resolver
}
