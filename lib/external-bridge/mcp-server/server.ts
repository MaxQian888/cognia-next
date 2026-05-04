/**
 * MCP server factory.
 *
 * Builds an `McpServer` instance with Cognia's tools + resources wired
 * through the permission gate + audit log. The transport (stdio / HTTP /
 * in-memory test) is supplied by the caller — `connect(transport)` runs
 * the SDK's protocol loop until the transport closes.
 *
 * Every tool/resource call follows the same shape:
 *   1. Get current `ExternalBridgeSettings` via the injected getter.
 *   2. Run the permission gate.
 *   3. On allow, dispatch to the handler module under `../handlers/`.
 *   4. Record latency + outcome via `recordCall`.
 *   5. Convert handler output to MCP envelope shape.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ExternalBridgeSettings } from "@/types/wiki"
import { ALL_BRIDGE_SCOPES } from "@/types/wiki"
import { recordCall } from "../audit-log"
import { checkRuntimeCall, checkScope, checkToolCall } from "../permission-gate"
import { ragSearch } from "../handlers/rag"
import {
  listResources,
  parseResourceUri,
  readResource,
  scopeForResourceUri,
} from "../handlers/resources"
import { runtimeQuery, type RuntimeEntityType } from "../handlers/runtime"
import { wikiRead, wikiSearch } from "../handlers/wiki"

/** Function the caller injects so the server always sees fresh settings. */
export type SettingsGetter = () => Promise<ExternalBridgeSettings | undefined>

export interface BuildServerOptions {
  serverInfo?: { name: string; version: string }
  settingsGetter: SettingsGetter
}

const DEFAULT_SERVER_INFO = { name: "cognia", version: "0.1.0" }

/**
 * Build the McpServer. The returned instance is not connected yet —
 * caller passes a transport via `server.connect(transport)`.
 *
 * We pre-declare `tools` + `resources` capabilities so the SDK's runtime
 * `assertRequestHandlerCapability` check accepts our low-level
 * `resources/*` request handlers (registered via `server.server`).
 */
export function buildMcpServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer(opts.serverInfo ?? DEFAULT_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
  })

  registerWikiTools(server, opts.settingsGetter)
  registerRagTool(server, opts.settingsGetter)
  registerRuntimeTool(server, opts.settingsGetter)
  registerResources(server, opts.settingsGetter)

  return server
}

// ─────────────────────────────────────────────────────────────────────────────
// wiki_search / wiki_read
// ─────────────────────────────────────────────────────────────────────────────

function registerWikiTools(server: McpServer, settingsGetter: SettingsGetter) {
  server.registerTool(
    "wiki_search",
    {
      title: "Search Cognia wiki",
      description:
        "Semantic search over Cognia's generated code wiki articles. " +
        "Returns top-K article summaries with slugs you can pass to wiki_read.",
      inputSchema: {
        query: z.string().describe("Natural language query"),
        scope: z
          .enum(["cognia-self", "user-repo", "runtime", "all"])
          .optional()
          .describe("Wiki scope filter (default: all)"),
        k: z.number().int().min(1).max(20).optional().describe("Result count (default 5)"),
      },
    },
    async (args) =>
      runWithGate({
        tool: "wiki_search",
        scope: "wiki:cognia",
        check: checkToolCall(await settingsGetter(), "wiki_search"),
        body: () => wikiSearch({ query: args.query, scope: args.scope, k: args.k }),
      })
  )

  server.registerTool(
    "wiki_read",
    {
      title: "Read a Cognia wiki article",
      description: "Fetch the full Markdown body of a wiki article by slug.",
      inputSchema: { slug: z.string().describe("Article slug (from wiki_search results)") },
    },
    async (args) =>
      runWithGate({
        tool: "wiki_read",
        scope: "wiki:cognia",
        check: checkToolCall(await settingsGetter(), "wiki_read"),
        body: async () => {
          const article = await wikiRead({ slug: args.slug })
          if (!article) return { error: `wiki article '${args.slug}' not found` }
          return article
        },
      })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// rag_search
// ─────────────────────────────────────────────────────────────────────────────

function registerRagTool(server: McpServer, settingsGetter: SettingsGetter) {
  server.registerTool(
    "rag_search",
    {
      title: "Search Cognia code (RAG)",
      description:
        "Chunk-level retrieval over Cognia's wiki sections. Use for fine-grained " +
        "code passages; for module-level overviews use wiki_search.",
      inputSchema: {
        query: z.string(),
        scope: z.enum(["cognia-self", "user-repo", "runtime", "all"]).optional(),
        k: z.number().int().min(1).max(30).optional(),
        rerank: z.boolean().optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "rag_search",
        scope: "rag:cognia",
        check: checkToolCall(await settingsGetter(), "rag_search"),
        body: () =>
          ragSearch({
            query: args.query,
            scope: args.scope,
            k: args.k,
            rerank: args.rerank,
          }),
      })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// runtime_query
// ─────────────────────────────────────────────────────────────────────────────

const RUNTIME_ENTITY_TYPES = ["skill", "character", "twin", "plugin", "agent-team"] as const

function registerRuntimeTool(server: McpServer, settingsGetter: SettingsGetter) {
  server.registerTool(
    "runtime_query",
    {
      title: "Query Cognia runtime entities",
      description:
        "List or get a runtime entity (skill/character/twin/plugin/agent-team). " +
        "Honors the per-entity OptIn whitelist.",
      inputSchema: {
        entityType: z.enum(RUNTIME_ENTITY_TYPES),
        op: z.enum(["list", "get"]),
        id: z.string().optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const settings = await settingsGetter()
      const check = checkRuntimeCall(settings, args.entityType)
      // The audit-log scope reflects what was actually checked even on
      // unknown entity types — the gate already mapped it to a scope or
      // rejected with reason.
      const scope = mapEntityToScope(args.entityType)
      return runWithGate({
        tool: "runtime_query",
        scope,
        check,
        body: () =>
          runtimeQuery({
            entityType: args.entityType as RuntimeEntityType,
            op: args.op,
            id: args.id,
            filter: args.filter,
          }),
      })
    }
  )
}

function mapEntityToScope(entityType: string) {
  switch (entityType) {
    case "skill":
      return "runtime:skills" as const
    case "character":
      return "runtime:characters" as const
    case "twin":
      return "runtime:twins" as const
    case "plugin":
      return "runtime:plugins" as const
    case "agent-team":
      return "runtime:agent-teams" as const
    default:
      return "n/a" as const
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resources
// ─────────────────────────────────────────────────────────────────────────────

function registerResources(server: McpServer, settingsGetter: SettingsGetter) {
  // The MCP SDK's high-level resource API expects either fixed URIs or
  // URI templates. We back the resources by overriding the underlying
  // request handlers via `server.server.setRequestHandler` so the dynamic
  // (Dexie-driven) listing logic stays in our handler module.
  const lowLevel = server.server

  lowLevel.setRequestHandler(ResourceListSchema, async () => {
    const start = Date.now()
    const settings = await settingsGetter()
    const enabled = settings?.enabledScopes ?? []
    try {
      const resources = await listResources(enabled)
      await recordCall({
        tool: "resources/list",
        scope: "n/a",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return { resources }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await recordCall({
        tool: "resources/list",
        scope: "n/a",
        check: { allowed: true },
        latencyMs: Date.now() - start,
        errorMessage: message,
      })
      throw err
    }
  })

  lowLevel.setRequestHandler(ResourceReadSchema, async (request) => {
    const start = Date.now()
    const uri = request.params.uri
    const settings = await settingsGetter()
    const requiredScope = await scopeForResourceUri(uri)
    const check = requiredScope
      ? checkScope(settings, requiredScope)
      : ({ allowed: false, reason: `unknown resource uri '${uri}'` } as const)
    if (!check.allowed) {
      await recordCall({
        tool: "resources/read",
        scope: requiredScope ?? "n/a",
        check,
        latencyMs: Date.now() - start,
      })
      throw new Error(check.reason)
    }
    const parts = parseResourceUri(uri)
    if (!parts) {
      await recordCall({
        tool: "resources/read",
        scope: requiredScope ?? "n/a",
        check: { allowed: false, reason: "malformed uri" },
        latencyMs: Date.now() - start,
      })
      throw new Error(`malformed resource uri '${uri}'`)
    }
    const content = await readResource(uri)
    await recordCall({
      tool: "resources/read",
      scope: requiredScope ?? "n/a",
      check: { allowed: true },
      latencyMs: Date.now() - start,
    })
    if (!content) return { contents: [] }
    return {
      contents: [
        {
          uri: content.uri,
          mimeType: content.mimeType,
          text: content.text,
        },
      ],
    }
  })
}

// Minimal request-shape schemas that match the MCP `resources/list` and
// `resources/read` envelopes. We keep them inline so the file doesn't pull
// the entire SDK types surface.
const ResourceListSchema = z
  .object({ method: z.literal("resources/list"), params: z.optional(z.object({}).passthrough()) })
  .passthrough()

const ResourceReadSchema = z
  .object({
    method: z.literal("resources/read"),
    params: z.object({ uri: z.string() }).passthrough(),
  })
  .passthrough()

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RunWithGateInput<T> {
  tool: string
  scope: (typeof ALL_BRIDGE_SCOPES)[number] | "n/a"
  check: { allowed: true } | { allowed: false; reason: string }
  body: () => Promise<T>
}

interface ToolEnvelope {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
  // Index signature satisfies the SDK's `Result extends Record<string,
  // unknown>` constraint on tool callback return types.
  [key: string]: unknown
}

/**
 * Common dispatch for tool callbacks: gate → record → run → wrap response in
 * the MCP `{ content }` envelope. Permission denials become `isError: true`
 * with a human-readable message; handler exceptions get the same treatment
 * after being logged.
 */
async function runWithGate<T>(input: RunWithGateInput<T>): Promise<ToolEnvelope> {
  const start = Date.now()
  if (!input.check.allowed) {
    await recordCall({
      tool: input.tool,
      scope: input.scope,
      check: input.check,
      latencyMs: Date.now() - start,
    })
    return {
      content: [{ type: "text", text: input.check.reason }],
      isError: true,
    }
  }
  try {
    const result = await input.body()
    await recordCall({
      tool: input.tool,
      scope: input.scope,
      check: { allowed: true },
      latencyMs: Date.now() - start,
    })
    // MCP requires `structuredContent` to be a JSON object (Record). Arrays
    // and primitives are wrapped under `{ value: ... }` so they survive
    // round-trip without violating the schema.
    const structured: Record<string, unknown> =
      result !== null && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { value: result }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: structured,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordCall({
      tool: input.tool,
      scope: input.scope,
      check: { allowed: true },
      latencyMs: Date.now() - start,
      errorMessage: message,
    })
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    }
  }
}

export const __TESTING__ = { mapEntityToScope, runWithGate, ResourceListSchema, ResourceReadSchema }
