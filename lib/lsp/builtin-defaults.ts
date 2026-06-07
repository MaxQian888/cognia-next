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
    install: { npmPackage: "typescript-language-server" },
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
    install: { npmPackage: "pyright" },
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
    // Distributed as a platform binary (rustup component) — no npm package,
    // so the ladder stops at detection.
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
    // Installed via `go install golang.org/x/tools/gopls@latest` — the
    // go-install rung is a follow-up; detection-only for now.
  },
  // ── npm-provisioned generic servers ──────────────────────────────────────
  // No rootMarkers: `buildServers` (sidecar/lsp/servers.mjs) anchors a
  // marker-less server at the agent cwd, which is right for file-scoped
  // servers like json/css/html/yaml/bash.
  {
    id: "json",
    name: "JSON",
    languages: ["json", "jsonc"],
    extensions: [".json", ".jsonc"],
    command: "vscode-json-language-server",
    args: ["--stdio"],
    transport: "stdio",
    install: { npmPackage: "vscode-langservers-extracted" },
  },
  {
    id: "css",
    name: "CSS",
    languages: ["css", "scss", "less"],
    extensions: [".css", ".scss", ".less"],
    command: "vscode-css-language-server",
    args: ["--stdio"],
    transport: "stdio",
    install: { npmPackage: "vscode-langservers-extracted" },
  },
  {
    id: "html",
    name: "HTML",
    languages: ["html"],
    extensions: [".html", ".htm"],
    command: "vscode-html-language-server",
    args: ["--stdio"],
    transport: "stdio",
    install: { npmPackage: "vscode-langservers-extracted" },
  },
  {
    id: "yaml",
    name: "YAML",
    languages: ["yaml"],
    extensions: [".yaml", ".yml"],
    command: "yaml-language-server",
    args: ["--stdio"],
    transport: "stdio",
    install: { npmPackage: "yaml-language-server" },
  },
  {
    id: "bash",
    name: "Bash",
    languages: ["shellscript"],
    extensions: [".sh", ".bash"],
    filenames: [".bashrc", ".bash_profile", ".zshrc"],
    command: "bash-language-server",
    args: ["start"],
    transport: "stdio",
    install: { npmPackage: "bash-language-server" },
  },
  // NOTE: an `eslint` entry (vscode-langservers-extracted ships
  // vscode-eslint-language-server) is deliberately absent — that server
  // requires a client-side ESLint configuration handshake
  // (workspace/configuration `validate`/`nodePath` sections) we don't
  // implement yet; shipping it would surface as a crashed server on every
  // TS/JS project.
]

/** Set of builtin ids, for quick "is this a builtin?" checks in the UI. */
export const BUILTIN_LSP_SERVER_IDS: ReadonlySet<string> = new Set(
  BUILTIN_LSP_SERVERS.map((s) => s.id)
)
