// LSP builtin tools — agent-facing code intelligence.
//
// Exposed as the `lsp` category of the cognia-tools MCP server. Unlike
// the stateless git/file-extras tools, these are bound to a per-session
// LSP *resolver* (see `sidecar/lsp/resolver.mjs`) which reuses the
// vscode-ext-host `LspService` for the actual provider requests. The
// resolver is injected by the dispatch layer, so the agent can only
// introspect files inside its own session cwd.
//
// API positions are 1-based (matching editor UIs); converted to LSP's
// 0-based positions internally. Mirrors OpenCode's `lsp` tool surface
// minus completion/formatting (irrelevant to an agent).

import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { fileURLToPath } from "node:url"
import { formatDiagnostics } from "../lsp/report.mjs"
import { toolError, toolText } from "./safety.mjs"

/** Render an LSP Location / Location[] / LocationLink[] into concise text. */
export function formatLocations(result) {
  if (result == null) return "No results."
  const arr = Array.isArray(result) ? result : [result]
  if (arr.length === 0) return "No results."
  const lines = arr.map((loc) => {
    // LocationLink uses `targetUri`/`targetRange`; Location uses `uri`/`range`.
    const uri = loc.uri ?? loc.targetUri
    const range = loc.range ?? loc.targetRange ?? loc.targetSelectionRange
    const line = (range?.start?.line ?? 0) + 1
    const col = (range?.start?.character ?? 0) + 1
    let display = uri
    try {
      if (typeof uri === "string" && uri.startsWith("file:")) display = fileURLToPath(uri)
    } catch {
      /* keep raw uri */
    }
    return `${display}:${line}:${col}`
  })
  return lines.join("\n")
}

/** Render an LSP Hover result into text. */
export function formatHover(result) {
  if (!result || result.contents == null) return "No hover information."
  const c = result.contents
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c.map((part) => (typeof part === "string" ? part : (part?.value ?? ""))).join("\n\n")
  }
  return c.value ?? JSON.stringify(c)
}

/** Render LSP DocumentSymbol[] / SymbolInformation[] into an indented tree. */
export function formatSymbols(result) {
  if (!Array.isArray(result) || result.length === 0) return "No symbols."
  const SYMBOL_KIND = {
    5: "class",
    6: "method",
    9: "constructor",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    23: "struct",
  }
  const out = []
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const kind = SYMBOL_KIND[n.kind] ?? "symbol"
      const line = (n.range?.start?.line ?? n.location?.range?.start?.line ?? 0) + 1
      out.push(`${"  ".repeat(depth)}${kind} ${n.name} (L${line})`)
      if (Array.isArray(n.children)) walk(n.children, depth + 1)
    }
  }
  walk(result, 0)
  return out.join("\n")
}

const pos = (line, character) => ({ line: line - 1, character: character - 1 })

async function runLspTool(name, fn) {
  try {
    return toolText(await fn())
  } catch (err) {
    return toolError(err, name)
  }
}

/**
 * Build the LSP tool set bound to a session resolver.
 * @param {{ request: Function, getDiagnostics: Function }} resolver
 * @returns {Array} tool defs
 */
export function createLspTools(resolver) {
  return [
    tool(
      "lsp_goto_definition",
      "Find where the symbol at a position is defined. Returns file:line:col locations.",
      {
        file: z.string().describe("Absolute path to the source file."),
        line: z.number().int().min(1).describe("1-based line number."),
        character: z.number().int().min(1).describe("1-based column number."),
      },
      async (args) => {
        return runLspTool("lsp_goto_definition", async () => {
          const res = await resolver.request(args.file, "definition", {
            position: pos(args.line, args.character),
          })
          return formatLocations(res)
        })
      }
    ),
    tool(
      "lsp_find_references",
      "Find all references to the symbol at a position. Returns file:line:col locations.",
      {
        file: z.string().describe("Absolute path to the source file."),
        line: z.number().int().min(1).describe("1-based line number."),
        character: z.number().int().min(1).describe("1-based column number."),
      },
      async (args) => {
        return runLspTool("lsp_find_references", async () => {
          const res = await resolver.request(args.file, "references", {
            position: pos(args.line, args.character),
          })
          return formatLocations(res)
        })
      }
    ),
    tool(
      "lsp_hover",
      "Get type/signature/doc information for the symbol at a position.",
      {
        file: z.string().describe("Absolute path to the source file."),
        line: z.number().int().min(1).describe("1-based line number."),
        character: z.number().int().min(1).describe("1-based column number."),
      },
      async (args) => {
        return runLspTool("lsp_hover", async () => {
          const res = await resolver.request(args.file, "hover", {
            position: pos(args.line, args.character),
          })
          return formatHover(res)
        })
      }
    ),
    tool(
      "lsp_document_symbols",
      "List the symbols (classes, functions, variables) defined in a file.",
      {
        file: z.string().describe("Absolute path to the source file."),
      },
      async (args) => {
        return runLspTool("lsp_document_symbols", async () => {
          const res = await resolver.request(args.file, "documentSymbol", {})
          return formatSymbols(res)
        })
      }
    ),
    tool(
      "lsp_diagnostics",
      "Get current compiler/linter diagnostics (errors and warnings) for a file.",
      {
        file: z.string().describe("Absolute path to the source file."),
      },
      async (args) => {
        return runLspTool("lsp_diagnostics", async () => {
          const diags = await resolver.getDiagnostics(args.file)
          const block = formatDiagnostics(args.file, diags, { minSeverity: 4 })
          return block ?? "No diagnostics."
        })
      }
    ),
  ]
}

/** Bare tool names — for the disabled-category denylist in index.mjs. */
export const LSP_TOOL_NAMES = [
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_hover",
  "lsp_document_symbols",
  "lsp_diagnostics",
]
