/**
 * Builtin Language Server defaults.
 *
 * These four servers were previously hard-coded inside the agent runtime at
 * `sidecar/lsp/servers.mjs`. They now live here as declarative
 * {@link LspServerConfig} entries so the resolver
 * (`lib/lsp/resolve-config.ts`) can layer user + project overrides on top of
 * them by `id`, and the SAME resolved list drives both the agent sidecar and
 * the editor LSP registry.
 *
 * A user (or project `.cognia/lsp.json`) re-declaring one of these ids
 * overrides the matching default field-by-field; setting `enabled: false`
 * disables the builtin entirely. The agent sidecar (a separate Node project
 * that cannot import this module) receives the resolved list via
 * `sendOptions.lsp` — it never reads this file directly.
 */

import type { LspServerConfig } from "@/types/lsp/config"

/**
 * Default servers, mirroring the original hard-coded `SERVERS` registry. Each
 * carries both `languages` (editor-side selection) and `extensions` /
 * `rootMarkers` (agent-side file-match + workspace-root resolution).
 */
export const BUILTIN_LSP_SERVERS: readonly LspServerConfig[] = [
  {
    id: "typescript",
    name: "TypeScript",
    languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    // A `deno.json` closer to the file hands the tree to the Deno toolchain.
    excludeRootMarkers: ["deno.json", "deno.jsonc"],
    transport: "stdio",
  },
  {
    id: "pyright",
    name: "Pyright",
    languages: ["python"],
    extensions: [".py", ".pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    transport: "stdio",
    workspaceFolderRequired: true,
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    languages: ["rust"],
    extensions: [".rs"],
    command: "rust-analyzer",
    rootMarkers: ["Cargo.toml"],
    transport: "stdio",
    workspaceFolderRequired: true,
  },
  {
    id: "gopls",
    name: "gopls",
    languages: ["go"],
    extensions: [".go"],
    command: "gopls",
    rootMarkers: ["go.work", "go.mod"],
    transport: "stdio",
    workspaceFolderRequired: true,
  },
]

/** Set of builtin ids, for quick "is this a builtin?" checks in the UI. */
export const BUILTIN_LSP_SERVER_IDS: ReadonlySet<string> = new Set(
  BUILTIN_LSP_SERVERS.map((s) => s.id)
)
