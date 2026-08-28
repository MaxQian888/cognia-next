/**
 * Fixture plugin demonstrating the Phase B LSP contribution path
 * (~/.claude/plans/vscode-lsp-mighty-robin.md).
 *
 * The actual LSP server is declared in `plugin.json:lspServers[]` —
 * cognia's plugin manager calls `lib/plugin/lsp/lsp-registry.ts:
 * registerPluginLspServers` on enable, which spawns the fixture binary
 * through the sidecar's `CogniaLspClient`. There is no runtime work
 * for the plugin module beyond exporting an empty `activate`.
 *
 * Used by the Phase B verification suite. Not intended for end users.
 */

import type { PluginContext } from "@cognia/plugin-sdk"

export function activate(ctx: PluginContext): void {
  ctx.logger.info(
    "test-lsp-contribution: activated. Echo LSP registration is driven by manifest.lspServers + lsp-registry."
  )
}

export function deactivate(): void {
  // No-op — the registry unregisters the LSP through unregisterByOwner.
}
