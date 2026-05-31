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
import { serversForFile } from "./servers.mjs"

const OWNER = "agent"
const DEFAULT_DIAGNOSTICS_WAIT_MS = 800

/** Stable, short, dependency-free hash for serverId disambiguation. */
function djb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}

/** Default binary check: resolve `command` against PATH (sync). */
function defaultEnsureCommand(command) {
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

function normalizeUri(uri) {
  return process.platform === "win32" ? uri.toLowerCase() : uri
}

/**
 * @param {object} args
 * @param {object} args.service  An LspService instance (start/didOpen/didChange/request/stop).
 * @param {string} args.cwd      Agent working directory (root boundary).
 * @param {(command: string, ctx: { serverId: string, root: string }) => Promise<string|null>|string|null} [args.ensureCommand]
 * @param {{ info?: Function, warn?: Function, error?: Function }} [args.logger]
 * @param {number} [args.diagnosticsWaitMs]
 */
export function createLspResolver(args) {
  const { service, cwd } = args
  const ensureCommand = args.ensureCommand ?? defaultEnsureCommand
  const logger = args.logger ?? {}
  const diagnosticsWaitMs = args.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS

  /** uri(normalized) -> diagnostics[] */
  const diagnostics = new Map()
  /** serverId -> { server, root } */
  const servers = new Map()
  /** `${serverId}\n${uri}` -> true once didOpen'd */
  const openDocs = new Set()

  /** Feed a `lsp:publishDiagnostics` notification payload into the cache. */
  function ingestDiagnostics(params) {
    if (!params || !params.uri) return
    diagnostics.set(normalizeUri(params.uri), params.diagnostics ?? [])
  }

  function serverIdFor(server, root) {
    return `${server.id}#${djb2(root)}`
  }

  async function ensureServer(server, root) {
    const serverId = serverIdFor(server, root)
    if (servers.has(serverId)) return serverId
    const spawn = server.resolveCommand(root, { cwd })
    const resolved = await ensureCommand(spawn.command, { serverId, root })
    if (!resolved) {
      logger.warn?.(`[lsp] binary not found for ${server.id}: ${spawn.command} (skipping)`)
      return null
    }
    const folderUri = pathToFileURL(root.endsWith(path.sep) ? root : root + path.sep).href
    try {
      await service.start({
        ownerId: OWNER,
        serverId,
        command: resolved,
        args: spawn.args ?? [],
        env: spawn.env,
        cwd: root,
        transport: "stdio",
        workspaceFolders: [{ uri: folderUri, name: path.basename(root) || root }],
        initializationOptions: spawn.initializationOptions,
      })
    } catch (err) {
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
   * matching touch.
   *
   * @param {string} absPath
   * @param {string} [text]  Current contents; read from disk when omitted.
   * @returns {Promise<string[]>}
   */
  async function touchFile(absPath, text) {
    const candidates = serversForFile(absPath)
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
    const touched = []
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
   *
   * @param {string} absPath
   * @param {{ text?: string, waitMs?: number }} [opts]
   * @returns {Promise<Array>}
   */
  async function getDiagnostics(absPath, opts = {}) {
    const touched = await touchFile(absPath, opts.text)
    if (touched.length === 0) return []
    await delay(opts.waitMs ?? diagnosticsWaitMs)
    return diagnostics.get(normalizeUri(pathToFileURL(absPath).href)) ?? []
  }

  /**
   * Run an LSP provider request for a file. Ensures a server is running,
   * then reuses `LspService.request`. Position is LSP-shaped (0-based).
   *
   * @param {string} absPath
   * @param {string} method  e.g. "definition" | "references" | "hover" | "documentSymbol"
   * @param {Record<string, unknown>} payload  must include the per-method fields (position, etc.)
   * @returns {Promise<unknown>}
   */
  async function request(absPath, method, payload = {}) {
    const touched = await touchFile(absPath, payload.text)
    if (touched.length === 0) {
      throw new Error(`lsp: no language server available for ${absPath}`)
    }
    const serverId = touched[0]
    const uri = pathToFileURL(absPath).href
    return service.request({ ownerId: OWNER, serverId, method, payload: { ...payload, uri } })
  }

  /** Stop all servers this resolver started. */
  async function dispose() {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
