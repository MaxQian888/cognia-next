// Agent-side LSP resolver.
//
// This is the thin layer that turns "the agent touched a file" into the
// right `LspService.start(...)` + document-sync calls. It owns NO
// transport or lifecycle of its own — `LspService` (reused from
// vscode-ext-host) does spawning, dedupe, request dispatch, and
// diagnostics. The resolver only:
//   1. picks the candidate server(s) for a file (servers.mjs),
//   2. resolves the workspace root,
//   3. ensures the binary exists (PATH probe / Phase 4 install ladder),
//   4. builds LspStartParams and drives the injected LspService,
//   5. caches push-diagnostics so the PostToolUse hook and the `lsp`
//      tool can read them synchronously.
//
// The LspService is injected so unit tests can substitute a fake that
// records calls without spawning a real language server.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { sandboxedProcessTarget, sandboxedProcessEnv } from "../../platform/process/exec.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import { buildServers, serversForFile } from "./servers.ts"
import type { LspInstallSpec, ServerInfo } from "./servers.ts"

/** Identifies one open document on one server. */
interface DocumentParams {
  ownerId: string
  serverId: string
  uri: string
  languageId: string
  text: string
}

/** The vscode-ext-host `LspService` surface the resolver drives. */
export interface LspServiceLike {
  start(params: Record<string, unknown>): Promise<unknown>
  didOpen(params: DocumentParams): void
  didChange(params: DocumentParams): void
  request(params: {
    ownerId: string
    serverId: string
    method: string
    payload: Record<string, unknown>
  }): Promise<unknown>
  stop(ownerId: string, serverId: string): unknown
}

export interface LspLogger {
  info?(message: string, details?: unknown): void
  warn?(message: string, details?: unknown): void
  error?(message: string, details?: unknown): void
}

/** Resolve a server binary: a path, or null when it is unavailable. */
export type EnsureCommand = (
  command: string,
  ctx: { serverId: string; root: string; install?: LspInstallSpec | undefined }
) => Promise<string | null> | string | null

export interface LspResolverOptions {
  service: LspServiceLike
  /** Agent working directory (root boundary). */
  cwd: string
  /** Resolved LSP config list (from `sendOptions.lsp.servers`). */
  servers?: unknown
  ensureCommand?: EnsureCommand | undefined
  logger?: LspLogger | undefined
  diagnosticsWaitMs?: number
  builtinProcessSandbox?: ProcessSandboxScope | undefined
}

/** A published diagnostics notification, as `lsp:publishDiagnostics` carries it. */
export interface PublishDiagnosticsParams {
  uri?: string
  diagnostics?: unknown[]
}

export interface LspResolver {
  touchFile(absPath: string, text?: string): Promise<string[]>
  getDiagnostics(absPath: string, opts?: { text?: string; waitMs?: number }): Promise<unknown[]>
  request(absPath: string, method: string, payload?: Record<string, unknown>): Promise<unknown>
  ingestDiagnostics(params: PublishDiagnosticsParams | null | undefined): void
  dispose(): Promise<void>
}

const OWNER = "agent"
const DEFAULT_DIAGNOSTICS_WAIT_MS = 800

/** Stable, short, dependency-free hash for serverId disambiguation. */
function djb2(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}

/** Default binary check: resolve `command` against PATH (sync). */
function defaultEnsureCommand(command: string): string | null {
  if (!command) return null
  // Explicit path — trust it if it exists.
  if (command.includes(path.sep) || command.includes("/")) {
    return fs.existsSync(command) ? command : null
  }
  const envPath = process.env.PATH || process.env.Path || ""
  const dirs = envPath.split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

function normalizeUri(uri: string): string {
  return process.platform === "win32" ? uri.toLowerCase() : uri
}

export function createLspResolver(args: LspResolverOptions): LspResolver {
  const { service, cwd } = args
  const ensureCommand: EnsureCommand = args.ensureCommand ?? defaultEnsureCommand
  const logger: LspLogger = args.logger ?? {}
  const diagnosticsWaitMs = args.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS
  // The runnable server list is built once from the injected config. The
  // sidecar no longer owns a hard-coded registry — it consumes whatever the
  // renderer resolved (builtin ← user ← project).
  const builtServers = buildServers(args.servers ?? [])

  /** uri(normalized) -> diagnostics[] */
  const diagnostics = new Map<string, unknown[]>()
  /** serverId -> { server, root } */
  const servers = new Map<string, { server: ServerInfo; root: string }>()
  /** `${serverId}\n${uri}` -> true once didOpen'd */
  const openDocs = new Set<string>()
  /**
   * serverIds whose binary resolution or spawn already failed this session.
   * Without this, every file touch would retry the full ladder — including
   * a doomed npm install — turning one missing toolchain into per-edit lag.
   */
  const failedServers = new Set<string>()

  /** Feed a `lsp:publishDiagnostics` notification payload into the cache. */
  function ingestDiagnostics(params: PublishDiagnosticsParams | null | undefined): void {
    if (!params || !params.uri) return
    diagnostics.set(normalizeUri(params.uri), params.diagnostics ?? [])
  }

  function serverIdFor(server: ServerInfo, root: string): string {
    return `${server.id}#${djb2(root)}`
  }

  async function ensureServer(server: ServerInfo, root: string): Promise<string | null> {
    const serverId = serverIdFor(server, root)
    if (servers.has(serverId)) return serverId
    if (failedServers.has(serverId)) return null
    const spawn = server.resolveCommand(root, { cwd })
    const resolved = await ensureCommand(spawn.command, { serverId, root, install: server.install })
    if (!resolved) {
      failedServers.add(serverId)
      logger.warn?.(`[lsp] binary not found for ${server.id}: ${spawn.command} (skipping)`)
      return null
    }
    const folderUri = pathToFileURL(root.endsWith(path.sep) ? root : root + path.sep).href
    try {
      const target = sandboxedProcessTarget(
        resolved,
        spawn.args ?? [],
        root,
        args.builtinProcessSandbox
      )
      await service.start({
        ownerId: OWNER,
        serverId,
        command: target.command,
        args: target.args,
        env: args.builtinProcessSandbox
          ? sandboxedProcessEnv(process.env, args.builtinProcessSandbox, spawn.env)
          : spawn.env,
        ...(args.builtinProcessSandbox ? { inheritEnv: false } : {}),
        cwd: root,
        transport: "stdio",
        workspaceFolders: [{ uri: folderUri, name: path.basename(root) || root }],
        initializationOptions: spawn.initializationOptions,
        // Per-server `settings` drive the LSP `workspace/configuration` pull
        // and the post-init `didChangeConfiguration` push (lsp-client).
        settings: server.settings,
      })
    } catch (err) {
      failedServers.add(serverId)
      logger.warn?.(`[lsp] failed to start ${server.id}`, {
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
    servers.set(serverId, { server, root })
    return serverId
  }

  /**
   * Open/sync a file with every applicable server. Returns the serverIds
   * that were touched (running). Lazy: spawns a server only on first
   * matching touch. `text` is the current contents; read from disk when omitted.
   */
  async function touchFile(absPath: string, text?: string): Promise<string[]> {
    const candidates = serversForFile(absPath, builtServers)
    if (candidates.length === 0) return []
    let content = text
    if (content == null) {
      try {
        content = fs.readFileSync(absPath, "utf-8")
      } catch {
        return []
      }
    }
    const uri = pathToFileURL(absPath).href
    const languageId = path.extname(absPath).slice(1) || "plaintext"
    const touched: string[] = []
    for (const server of candidates) {
      const root = server.root(absPath, { cwd })
      if (!root) continue
      const serverId = await ensureServer(server, root)
      if (!serverId) continue
      const docKey = `${serverId}\n${uri}`
      try {
        if (openDocs.has(docKey)) {
          service.didChange({ ownerId: OWNER, serverId, uri, languageId, text: content })
        } else {
          service.didOpen({ ownerId: OWNER, serverId, uri, languageId, text: content })
          openDocs.add(docKey)
        }
        touched.push(serverId)
      } catch (err) {
        logger.warn?.(`[lsp] didOpen/didChange failed for ${serverId}`, {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return touched
  }

  /**
   * touchFile then wait briefly for push-diagnostics to land, returning
   * the cached diagnostics for the file (possibly empty).
   */
  async function getDiagnostics(
    absPath: string,
    opts: { text?: string; waitMs?: number } = {}
  ): Promise<unknown[]> {
    const touched = await touchFile(absPath, opts.text)
    if (touched.length === 0) return []
    await delay(opts.waitMs ?? diagnosticsWaitMs)
    return diagnostics.get(normalizeUri(pathToFileURL(absPath).href)) ?? []
  }

  /**
   * Run an LSP provider request for a file. Ensures a server is running,
   * then reuses `LspService.request`. Position is LSP-shaped (0-based).
   * `method` is e.g. "definition" | "references" | "hover" | "documentSymbol";
   * `payload` must include the per-method fields (position, etc.).
   */
  async function request(
    absPath: string,
    method: string,
    payload: Record<string, unknown> = {}
  ): Promise<unknown> {
    const touched = await touchFile(absPath, payload.text as string | undefined)
    if (touched.length === 0) {
      throw new Error(`lsp: no language server available for ${absPath}`)
    }
    const serverId = touched[0]!
    const uri = pathToFileURL(absPath).href
    return service.request({ ownerId: OWNER, serverId, method, payload: { ...payload, uri } })
  }

  /** Stop all servers this resolver started. */
  async function dispose(): Promise<void> {
    for (const serverId of servers.keys()) {
      try {
        await service.stop(OWNER, serverId)
      } catch {
        /* swallow */
      }
    }
    servers.clear()
    openDocs.clear()
    diagnostics.clear()
  }

  return { touchFile, getDiagnostics, request, ingestDiagnostics, dispose }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
