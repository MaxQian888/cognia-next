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

import { fileURLToPath } from "node:url"
import path from "node:path"
import { createLspResolver } from "./resolver.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LSP_SERVICE_PATH = path.resolve(HERE, "../vscode-ext-host/dist/lsp-service.js")

let lspServiceCtorPromise = null

/** Dynamically import the compiled `LspService` constructor (cached). */
export async function loadLspServiceCtor() {
  if (!lspServiceCtorPromise) {
    lspServiceCtorPromise = (async () => {
      const mod = await import(pathToImportUrl(LSP_SERVICE_PATH))
      const Ctor = mod.LspService ?? mod.default?.LspService ?? mod.default
      if (typeof Ctor !== "function") {
        throw new Error("LspService not found in compiled vscode-ext-host bundle")
      }
      return Ctor
    })()
  }
  return lspServiceCtorPromise
}

function pathToImportUrl(p) {
  // On Windows a bare path import must be a file:// URL.
  return process.platform === "win32" ? `file://${p.replace(/\\/g, "/")}` : p
}

/**
 * Create a resolver backed by a real per-session LspService. Returns
 * `null` when the LSP host can't be loaded (e.g. dist not built / mobile)
 * so callers can no-op gracefully.
 *
 * @param {{ cwd: string, logger?: object, ensureCommand?: Function }} opts
 * @returns {Promise<ReturnType<typeof createLspResolver> | null>}
 */
export async function createSessionLspResolver(opts) {
  let LspService
  try {
    LspService = await loadLspServiceCtor()
  } catch (err) {
    opts.logger?.warn?.("[lsp] LSP host unavailable — diagnostics disabled", {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Forward `lsp:publishDiagnostics` notifications into the resolver cache.
  let resolverRef = null
  const service = new LspService((method, params) => {
    if (method === "lsp:publishDiagnostics") resolverRef?.ingestDiagnostics(params)
  }, opts.logger ?? {})

  const resolver = createLspResolver({
    service,
    cwd: opts.cwd,
    ensureCommand: opts.ensureCommand,
    logger: opts.logger,
  })
  resolverRef = resolver
  return resolver
}
