/**
 * Plugin SDK - `lsp-server` capability surface.
 *
 * Re-exports the declarative authoring helper and the LSP registry's record
 * types. Plugins contribute servers through `manifest.lspServers`; the host's
 * registry spawns, gates and tears them down, so its mutators and live reads
 * stay host-side.
 */

export { defineLspServer } from "../define/define-lsp-server"

export { lspServerKey } from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"

export type {
  LspBridgeAdapter,
  LspClientAdapter,
  LspServerOwner,
  LspServerRecord,
  LspServerState,
} from "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry"

export type { PluginLspServerDef } from "@cognia/plugin-contract/types/plugin/index"
