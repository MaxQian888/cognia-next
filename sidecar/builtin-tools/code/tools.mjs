// Code-graph builtin tools — agent-facing structural code intelligence.
//
// Exposed as the `codeGraph` category of the cognia-tools MCP server. Like the
// LSP tools these are bound to a per-session resolver (the lazy code-graph
// index service from `dispatch/codegraph-resolver-factory.mjs`), so the agent
// only ever queries its own session cwd. All tools are read-only.
//
// Each handler first `syncStale()`s the index (lazily building it on the first
// call) and prepends the ⚠️ staleness banner when files changed on disk are
// pending re-index — mirroring codegraph's connect-time reconciliation.

import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

import { toolError, toolText } from "../safety.mjs"

/** Compact node row (token-frugal). */
function row(node) {
  if (!node) return null
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualified_name: node.qualified_name,
    file: node.file_path,
    line: node.start_line,
  }
}

/** Attach the staleness banner to a payload as a leading `warning` field. */
function withBanner(resolver, payload) {
  const banner = resolver.stalenessBanner()
  return banner ? { warning: banner, ...payload } : payload
}

/** Resolve `target` (a node id or qualified name) to a node, or throw. */
function resolveTarget(resolver, target) {
  const node = resolver.getNode(target)
  if (!node) throw new Error(`no indexed symbol matches "${target}" (try codegraph_search first)`)
  return node
}

async function run(resolver, name, fn) {
  try {
    await resolver.syncStale()
    return toolText(await fn())
  } catch (err) {
    return toolError(err, name)
  }
}

/**
 * Build the code-graph tool set bound to a session resolver.
 * @param {{
 *   ensureIndexed: Function, syncStale: Function, search: Function,
 *   getNode: Function, snippetFor: Function, callers: Function,
 *   callees: Function, impact: Function, context: Function, files: Function,
 *   status: Function, stalenessBanner: Function,
 * }} resolver
 * @returns {Array} tool defs
 */
export function createCodeGraphTools(resolver) {
  return [
    tool(
      "codegraph_status",
      "Report code-graph index health: indexed file/node/edge counts, language histogram, storage backend, and pending (changed-on-disk) files. Cheap — call first to confirm the graph is ready.",
      {},
      async () =>
        run(resolver, "codegraph_status", async () => withBanner(resolver, resolver.status()))
    ),
    tool(
      "codegraph_search",
      "Full-text search the code graph for symbols (functions, classes, methods, …) by name/doc. Returns ranked symbol rows with ids you can pass to codegraph_node / callers / callees / impact.",
      {
        query: z.string().min(1).describe("Search text — a symbol name or keywords."),
        kind: z
          .string()
          .optional()
          .describe("Restrict to a symbol kind (function/class/method/interface/struct/enum/…)."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max rows."),
      },
      async (args) =>
        run(resolver, "codegraph_search", async () =>
          withBanner(resolver, {
            results: resolver.search(args.query, { kind: args.kind, limit: args.limit }).map(row),
          })
        )
    ),
    tool(
      "codegraph_node",
      "Fetch one symbol by id or qualified name: its kind, signature, docstring, location, and verbatim source.",
      {
        target: z.string().min(1).describe("A node id (from search) or a qualified name."),
      },
      async (args) =>
        run(resolver, "codegraph_node", async () => {
          const node = resolveTarget(resolver, args.target)
          return withBanner(resolver, {
            ...row(node),
            signature: node.signature,
            docstring: node.docstring,
            visibility: node.visibility,
            is_exported: !!node.is_exported,
            is_async: !!node.is_async,
            end_line: node.end_line,
            source: resolver.snippetFor(node),
          })
        })
    ),
    tool(
      "codegraph_callers",
      "Who calls/references a symbol (transitive). Pass a node id or qualified name.",
      {
        target: z.string().min(1).describe("Node id or qualified name."),
        depth: z.number().int().min(1).max(8).default(3).describe("Traversal depth."),
      },
      async (args) =>
        run(resolver, "codegraph_callers", async () => {
          const node = resolveTarget(resolver, args.target)
          return withBanner(resolver, {
            target: node.qualified_name,
            callers: resolver
              .callers(node.id, args.depth)
              .map((r) => ({ ...row(r.node), distance: r.distance })),
          })
        })
    ),
    tool(
      "codegraph_callees",
      "What a symbol calls/references (transitive). Pass a node id or qualified name.",
      {
        target: z.string().min(1).describe("Node id or qualified name."),
        depth: z.number().int().min(1).max(8).default(3).describe("Traversal depth."),
      },
      async (args) =>
        run(resolver, "codegraph_callees", async () => {
          const node = resolveTarget(resolver, args.target)
          return withBanner(resolver, {
            target: node.qualified_name,
            callees: resolver
              .callees(node.id, args.depth)
              .map((r) => ({ ...row(r.node), distance: r.distance })),
          })
        })
    ),
    tool(
      "codegraph_impact",
      "Blast radius: everything that transitively depends on a symbol (callers + importers + subclasses). Use before changing a symbol.",
      {
        target: z.string().min(1).describe("Node id or qualified name."),
        depth: z.number().int().min(1).max(8).default(4).describe("Traversal depth."),
      },
      async (args) =>
        run(resolver, "codegraph_impact", async () => {
          const node = resolveTarget(resolver, args.target)
          const reached = resolver.impact(node.id, args.depth)
          return withBanner(resolver, {
            target: node.qualified_name,
            impactCount: reached.length,
            impacted: reached.map((r) => ({ ...row(r.node), distance: r.distance })),
          })
        })
    ),
    tool(
      "codegraph_context",
      "Get task-relevant context for a natural-language query in ONE call: entry-point symbols, the related subgraph, verbatim snippets, and related files — ranked by graph connectivity, under an adaptive output budget.",
      {
        query: z.string().min(1).describe("Natural-language description of the task/feature/area."),
      },
      async (args) =>
        run(resolver, "codegraph_context", async () =>
          formatContext(resolver, resolver.context(args.query))
        )
    ),
    tool(
      "codegraph_explore",
      "Like codegraph_context but seeded by explicitly named symbols — surveys the neighbourhood around the symbols you name. Use when you already know one or two symbol names.",
      {
        seeds: z.array(z.string().min(1)).min(1).describe("Symbol names to anchor the survey on."),
        query: z.string().optional().describe("Optional extra natural-language context."),
      },
      async (args) =>
        run(resolver, "codegraph_explore", async () =>
          formatContext(
            resolver,
            resolver.context(args.query ?? args.seeds.join(" "), {
              maxNodes: 16,
              namedSeeds: args.seeds,
            })
          )
        )
    ),
    tool(
      "codegraph_files",
      "List the indexed source files with their per-file symbol counts, language, and any extraction errors.",
      {},
      async () =>
        run(resolver, "codegraph_files", async () =>
          withBanner(resolver, {
            files: resolver.files().map((f) => ({
              path: f.path,
              language: f.language,
              symbols: f.node_count,
              errors: f.errors ? JSON.parse(f.errors) : undefined,
            })),
          })
        )
    ),
  ]
}

function formatContext(resolver, ctx) {
  return withBanner(resolver, {
    summary: ctx.summary,
    entryPoints: ctx.entryPoints.map(row),
    related: ctx.related.map((r) => ({ ...row(r.node), score: Math.round(r.score) })),
    snippets: ctx.snippets.map((s) => ({
      qualified_name: s.qualified_name,
      file: s.file,
      source: s.text,
    })),
    relatedFiles: ctx.relatedFiles,
    dropped: ctx.dropped.length ? ctx.dropped : undefined,
  })
}

export { CODE_GRAPH_TOOL_NAMES } from "./names.mjs"
