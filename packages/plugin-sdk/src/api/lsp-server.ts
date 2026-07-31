/**
 * Plugin SDK - `lsp-server` capability surface.
 *
 * Re-exports the declarative authoring helper and host LSP registry used to
 * materialize plugin-contributed language servers.
 */

export { defineLspServer } from "../define/define-lsp-server"

export {
  configureLspRegistry,
  getLspServerForLanguage,
  listLspServers,
  lspServerKey,
  registerLspServer,
  registerPluginLspServers,
  unregisterByOwner,
  unregisterLspServer,
} from "@/lib/plugin/lsp/lsp-registry"

export type {
  LspBridgeAdapter,
  LspClientAdapter,
  LspServerOwner,
  LspServerRecord,
  LspServerState,
} from "@/lib/plugin/lsp/lsp-registry"

export type { PluginLspServerDef } from "@/types/plugin"
