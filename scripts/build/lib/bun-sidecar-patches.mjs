// Source patches the compiled Bun CLI applies to sidecar modules at load time.
//
// A `bun build --compile` executable cannot read files that sit next to a
// sidecar module (schema.sql) or dynamically
// import the vscode-ext-host dist by computed path, so build-cli-bun.mjs
// rewrites those few lines while bundling. Each rewrite anchors on exact source
// text; the table lives here, as data, so a node --test suite can prove every
// anchor still matches exactly once (scripts/build/lib/bun-sidecar-patches.test.mjs)
// instead of the drift surfacing only when someone builds the CLI binary.
//
// Runs under both Node (the test) and Bun (the build), so it uses node:fs only.

import fs from "node:fs"
import path from "node:path"

/**
 * Replace the single occurrence of `search` in `source`.
 * Throws when `search` matches zero or several times, naming `label`.
 */
export function replaceExactly(source, search, replacement, label) {
  const matches =
    typeof search === "string"
      ? source.split(search).length - 1
      : [...source.matchAll(new RegExp(search.source, search.flags.includes("g") ? search.flags : `${search.flags}g`))]
          .length
  if (matches !== 1) {
    throw new Error(`build-cli-bun: ${label} expected exactly one source match; found ${matches}`)
  }
  return source.replace(search, () => replacement)
}

/**
 * @typedef {object} PatchContext
 * @property {string} root repo root
 * @property {string} filePath absolute path of the module being loaded
 *
 * @typedef {object} SidecarPatch
 * @property {string} file repo-relative path of the patched module
 * @property {"js" | "ts"} loader Bun loader for the patched contents
 * @property {Array<{ label: string, search: string | RegExp, replace: (ctx: PatchContext) => string }>} edits
 */

/** @type {SidecarPatch[]} */
export const BUN_SIDECAR_PATCHES = [
  {
    file: "sidecar/src/services/code-graph/store-sqlite.ts",
    loader: "ts",
    edits: [
      {
        label: "codegraph schema inline",
        search: 'const SCHEMA_SQL = fs.readFileSync(path.join(HERE, "schema.sql"), "utf-8")',
        replace: ({ filePath }) =>
          `const SCHEMA_SQL = ${JSON.stringify(fs.readFileSync(path.join(path.dirname(filePath), "schema.sql"), "utf8"))}`,
      },
    ],
  },
  {
    file: "sidecar/src/services/lsp/service-loader.ts",
    loader: "ts",
    edits: [
      {
        label: "LSP service static import",
        search: "import(pathToImportUrl(LSP_SERVICE_PATH))",
        replace: () => 'import("../../../vscode-ext-host/dist/lsp-service.js")',
      },
      {
        label: "LSP installer static import",
        search: "import(pathToImportUrl(LSP_INSTALLER_PATH))",
        replace: () => 'import("../../../vscode-ext-host/dist/lsp-installer.js")',
      },
    ],
  },
]

/** Bun `onLoad` filter matching the patch's module on any platform. */
export function patchFilter(patch) {
  const escaped = patch.file
    .split("/")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]")
  return new RegExp(`[\\\\/]${escaped}$`)
}

/** Apply every edit of `patch` to `source`. */
export function applySidecarPatch(patch, source, ctx) {
  return patch.edits.reduce((text, edit) => replaceExactly(text, edit.search, edit.replace(ctx), edit.label), source)
}
