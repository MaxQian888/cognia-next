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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { BridgeScope, ExternalBridgeSettings } from "@/types/wiki"
import { ALL_BRIDGE_SCOPES } from "@/types/wiki"
import { listAllWikiArticles, getWikiArticleBySlug } from "@/lib/db/wiki-articles"
import { listSkills, getSkill } from "@/lib/db/skills"
import { listCharacters, getCharacter } from "@/lib/db/characters"
import { recordCall } from "../audit-log"
import { checkRagCall, checkRuntimeCall, checkScope, checkToolCall } from "../permission-gate"
import { computerUse } from "../handlers/computer-use"
import { ragSearch } from "../handlers/rag"
import { parseResourceUri } from "../handlers/resources"
import { runtimeQuery, type RuntimeEntityType } from "../handlers/runtime"
import { wikiRead, wikiSearch } from "../handlers/wiki"
import {
  connectorsListAdapters,
  connectorsListConversations,
  connectorsGetAudit,
  connectorsExportAudit,
  connectorsListDrafts,
  connectorsSendMessage,
} from "../handlers/connectors"

/** Function the caller injects so the server always sees fresh settings. */
export type SettingsGetter = () => Promise<ExternalBridgeSettings | undefined>

export interface BuildServerOptions {
  serverInfo?: { name: string; version: string }
  settingsGetter: SettingsGetter
}

const DEFAULT_SERVER_INFO = { name: "cognia", version: "1.0.0" }

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
    capabilities: { tools: {}, resources: {}, prompts: {} },
  })

  registerWikiTools(server, opts.settingsGetter)
  registerRagTool(server, opts.settingsGetter)
  registerRuntimeTool(server, opts.settingsGetter)
  registerComputerUseTool(server, opts.settingsGetter)
  registerConnectorTools(server, opts.settingsGetter)
  registerResources(server, opts.settingsGetter)
  registerPrompts(server)

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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
        "Chunk-level retrieval over Cognia's wiki sections OR over a digital " +
        "twin's chunks (when scope='twin' and rag:twin is enabled). For " +
        "module-level overviews use wiki_search.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        query: z.string(),
        scope: z.enum(["cognia-self", "user-repo", "runtime", "all", "twin"]).optional(),
        twinId: z.string().optional(),
        k: z.number().int().min(1).max(30).optional(),
        rerank: z.boolean().optional(),
      },
    },
    async (args) => {
      const ragScope = args.scope ?? "all"
      const settings = await settingsGetter()
      // Per-call gate: rag:cognia for everything except twin (rag:twin),
      // which the user must opt into separately.
      return runWithGate({
        tool: "rag_search",
        scope: ragScope === "twin" ? "rag:twin" : "rag:cognia",
        check: checkRagCall(settings, ragScope),
        body: () =>
          ragSearch({
            query: args.query,
            scope: args.scope,
            twinId: args.twinId,
            k: args.k,
            rerank: args.rerank,
          }),
      })
    }
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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

// ─────────────────────────────────────────────────────────────────────────────
// computer_use — the desktop driving tool (default OFF; `mcp:computer-use`).
// ─────────────────────────────────────────────────────────────────────────────

function registerComputerUseTool(server: McpServer, settingsGetter: SettingsGetter) {
  server.registerTool(
    "computer_use",
    {
      title: "Drive the host computer",
      description:
        "Take a screenshot, move the cursor, click, scroll, type, send keyboard " +
        "chords, drag, or release mouse buttons on the user's desktop. Routes " +
        "through Cognia's automation permission gate (`Surface::Mcp`) — denied " +
        "by default until the user enables this scope in Settings → External " +
        "Bridge.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        action: z.enum([
          "screenshot",
          "click",
          "type",
          "keys",
          "mouse_move",
          "drag",
          "scroll",
          "hold_key",
          "mouse_button",
        ]),
        coordinate: z
          .tuple([z.number().int(), z.number().int()])
          .optional()
          .describe("Target [x, y]. Required for click / mouse_move / drag / scroll."),
        startCoordinate: z
          .tuple([z.number().int(), z.number().int()])
          .optional()
          .describe("Drag origin [x, y]."),
        button: z.enum(["left", "right", "middle"]).optional(),
        double: z.boolean().optional(),
        text: z.string().optional().describe("Text to type."),
        chord: z.string().optional().describe('Keyboard chord, e.g. "ctrl+shift+t" or "{F4}".'),
        dx: z.number().int().optional(),
        dy: z.number().int().optional(),
        durationMs: z.number().int().min(0).optional(),
        transition: z.enum(["down", "up"]).optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "computer_use",
        scope: "mcp:computer-use",
        check: checkToolCall(await settingsGetter(), "computer_use"),
        body: () => computerUse(args as Parameters<typeof computerUse>[0]),
      })
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox connector tools (v49) — read-only introspection + one write tool.
// ─────────────────────────────────────────────────────────────────────────────

function registerConnectorTools(server: McpServer, settingsGetter: SettingsGetter) {
  // connectors_list_adapters
  server.registerTool(
    "connectors_list_adapters",
    {
      title: "List Inbox adapters",
      description:
        "Return the registered platform adapters (Telegram / Discord / Slack / Lark / OneBot) with id, type, enabled flag, default mode, and muted state.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () =>
      runWithGate({
        tool: "connectors_list_adapters",
        scope: "inbox:connectors:read",
        check: checkToolCall(await settingsGetter(), "connectors_list_adapters"),
        body: () => connectorsListAdapters(),
      })
  )

  // connectors_list_conversations
  server.registerTool(
    "connectors_list_conversations",
    {
      title: "List Inbox conversations",
      description:
        "List conversations bound to a platform adapter with optional filters (adapterId, pinnedOnly, unreadOnly, archived).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        adapterId: z.string().optional(),
        pinnedOnly: z.boolean().optional(),
        unreadOnly: z.boolean().optional(),
        archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "connectors_list_conversations",
        scope: "inbox:connectors:read",
        check: checkToolCall(await settingsGetter(), "connectors_list_conversations"),
        body: () => connectorsListConversations(args),
      })
  )

  // connectors_get_audit
  server.registerTool(
    "connectors_get_audit",
    {
      title: "Fetch Inbox audit rows",
      description:
        "Read the connector audit log (delivery / inbound / breaker / callback / policy events). Optional adapterId and conversationKey filters.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        adapterId: z.string().optional(),
        conversationKey: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "connectors_get_audit",
        scope: "inbox:connectors:read",
        check: checkToolCall(await settingsGetter(), "connectors_get_audit"),
        body: () => connectorsGetAudit(args),
      })
  )

  // connectors_export_audit
  server.registerTool(
    "connectors_export_audit",
    {
      title: "Export Inbox audit (CSV/JSON)",
      description:
        "Serialise the audit log into CSV or JSON for incident reporting. The MCP client writes the returned `body` to a file locally.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        format: z.enum(["csv", "json"]),
        adapterId: z.string().optional(),
        conversationKey: z.string().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "connectors_export_audit",
        scope: "inbox:connectors:read",
        check: checkToolCall(await settingsGetter(), "connectors_export_audit"),
        body: () => connectorsExportAudit(args),
      })
  )

  // connectors_list_drafts
  server.registerTool(
    "connectors_list_drafts",
    {
      title: "List pending Inbox drafts",
      description:
        "Read the pending draft replies (operator-approval queue). Returns id, conversationKey, sessionId, status, createdAt, and a 240-char text preview.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () =>
      runWithGate({
        tool: "connectors_list_drafts",
        scope: "inbox:connectors:read",
        check: checkToolCall(await settingsGetter(), "connectors_list_drafts"),
        body: () => connectorsListDrafts(),
      })
  )

  // connectors_send_message — the single write-side tool.
  server.registerTool(
    "connectors_send_message",
    {
      title: "Send a connector message via the AI loop",
      description:
        "Enqueue an AI reply on an existing inbox conversation. Delegates to runConnectorDigestTurn so PII gate, policy resolver, idempotency cache, and outbound runner all stay in path. Requires the conversation to have a pre-existing ChatSession; returns `{ok:false, reason:'session_missing'}` otherwise. Default OFF; gate via Settings → External Bridge → inbox:connectors:send.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        adapterId: z.string(),
        conversationKey: z.string(),
        prompt: z.string(),
        characterId: z.string().optional(),
        sourceTaskId: z.string().optional(),
      },
    },
    async (args) =>
      runWithGate({
        tool: "connectors_send_message",
        scope: "inbox:connectors:send",
        check: checkToolCall(await settingsGetter(), "connectors_send_message"),
        body: () =>
          connectorsSendMessage({
            adapterId: args.adapterId,
            conversationKey: args.conversationKey,
            prompt: args.prompt,
            characterId: args.characterId,
            sourceTaskId: args.sourceTaskId,
          }),
      })
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
// Resources — registered via the high-level ResourceTemplate API.
// ─────────────────────────────────────────────────────────────────────────────

function registerResources(server: McpServer, settingsGetter: SettingsGetter) {
  registerWikiResource(server, settingsGetter)
  registerSkillResource(server, settingsGetter)
  registerCharacterResource(server, settingsGetter)
}

function registerWikiResource(server: McpServer, settingsGetter: SettingsGetter) {
  const template = new ResourceTemplate("cognia://wiki/{slug}", {
    list: async () => {
      const start = Date.now()
      const s = await settingsGetter()
      const enabled = new Set(s?.enabledScopes ?? [])
      if (!enabled.has("wiki:cognia") && !enabled.has("wiki:user-repo")) {
        await recordCall({
          tool: "resources/list:wiki",
          scope: "wiki:cognia",
          check: { allowed: false, reason: "scope OFF" },
          latencyMs: Date.now() - start,
        })
        return { resources: [] }
      }
      const articles = await listAllWikiArticles()
      const resources = articles
        .filter((a) => {
          const scope: BridgeScope = a.scope === "cognia-self" ? "wiki:cognia" : "wiki:user-repo"
          return enabled.has(scope)
        })
        .map((a) => ({
          uri: `cognia://wiki/${a.slug}`,
          name: a.title,
          description: a.summary,
          mimeType: "text/markdown" as const,
        }))
      await recordCall({
        tool: "resources/list:wiki",
        scope: "wiki:cognia",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return { resources }
    },
  })

  server.registerResource(
    "cognia-wiki",
    template,
    {
      title: "Cognia Wiki Article",
      description: "A generated code wiki article for a module in the Cognia codebase.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const start = Date.now()
      const s = await settingsGetter()
      const parts = parseResourceUri(uri.href)
      if (!parts) {
        await recordCall({
          tool: "resources/read:wiki",
          scope: "wiki:cognia",
          check: { allowed: false, reason: "malformed uri" },
          latencyMs: Date.now() - start,
        })
        throw new Error(`malformed resource uri '${uri.href}'`)
      }
      const article = await getWikiArticleBySlug(parts.id)
      const requiredScope: BridgeScope =
        article?.scope === "cognia-self" ? "wiki:cognia" : "wiki:user-repo"
      const check = checkScope(s, requiredScope)
      if (!check.allowed) {
        await recordCall({
          tool: "resources/read:wiki",
          scope: requiredScope,
          check,
          latencyMs: Date.now() - start,
        })
        throw new Error(check.reason)
      }
      if (!article) {
        await recordCall({
          tool: "resources/read:wiki",
          scope: requiredScope,
          check: { allowed: true },
          latencyMs: Date.now() - start,
        })
        throw new Error(`wiki article '${parts.id}' not found`)
      }
      await recordCall({
        tool: "resources/read:wiki",
        scope: requiredScope,
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: article.contentMd }] }
    }
  )
}

function registerSkillResource(server: McpServer, settingsGetter: SettingsGetter) {
  const template = new ResourceTemplate("cognia://skill/{id}", {
    list: async () => {
      const start = Date.now()
      const s = await settingsGetter()
      const enabled = new Set(s?.enabledScopes ?? [])
      if (!enabled.has("runtime:skills")) {
        await recordCall({
          tool: "resources/list:skill",
          scope: "runtime:skills",
          check: { allowed: false, reason: "scope OFF" },
          latencyMs: Date.now() - start,
        })
        return { resources: [] }
      }
      const skills = await listSkills()
      await recordCall({
        tool: "resources/list:skill",
        scope: "runtime:skills",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return {
        resources: skills.map((sk) => ({
          uri: `cognia://skill/${sk.id}`,
          name: sk.name,
          description: sk.description,
          mimeType: "text/markdown" as const,
        })),
      }
    },
  })

  server.registerResource(
    "cognia-skill",
    template,
    {
      title: "Cognia Skill",
      description: "A Cognia skill definition exported as SKILL.md.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const start = Date.now()
      const s = await settingsGetter()
      const check = checkScope(s, "runtime:skills")
      if (!check.allowed) {
        await recordCall({
          tool: "resources/read:skill",
          scope: "runtime:skills",
          check,
          latencyMs: Date.now() - start,
        })
        throw new Error(check.reason)
      }
      const parts = parseResourceUri(uri.href)
      if (!parts) {
        await recordCall({
          tool: "resources/read:skill",
          scope: "runtime:skills",
          check: { allowed: false, reason: "malformed uri" },
          latencyMs: Date.now() - start,
        })
        throw new Error(`malformed resource uri '${uri.href}'`)
      }
      const skill = await getSkill(parts.id)
      if (!skill) {
        await recordCall({
          tool: "resources/read:skill",
          scope: "runtime:skills",
          check: { allowed: true },
          latencyMs: Date.now() - start,
        })
        throw new Error(`skill '${parts.id}' not found`)
      }
      const { serializeSkill } = await import("@/lib/claude/skills-io")
      const text = serializeSkill({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        allowedTools: skill.allowedTools,
        tags: skill.tags,
        category: skill.category,
        version: skill.version,
        author: skill.author,
        license: skill.license,
      })
      await recordCall({
        tool: "resources/read:skill",
        scope: "runtime:skills",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }
    }
  )
}

function registerCharacterResource(server: McpServer, settingsGetter: SettingsGetter) {
  const template = new ResourceTemplate("cognia://character/{id}", {
    list: async () => {
      const start = Date.now()
      const s = await settingsGetter()
      const enabled = new Set(s?.enabledScopes ?? [])
      if (!enabled.has("runtime:characters")) {
        await recordCall({
          tool: "resources/list:character",
          scope: "runtime:characters",
          check: { allowed: false, reason: "scope OFF" },
          latencyMs: Date.now() - start,
        })
        return { resources: [] }
      }
      const characters = await listCharacters()
      await recordCall({
        tool: "resources/list:character",
        scope: "runtime:characters",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return {
        resources: characters.map((c) => ({
          uri: `cognia://character/${c.id}`,
          name: c.name,
          description: c.description,
          mimeType: "application/json" as const,
        })),
      }
    },
  })

  server.registerResource(
    "cognia-character",
    template,
    {
      title: "Cognia Character",
      description: "A Cognia character definition as JSON.",
      mimeType: "application/json",
    },
    async (uri) => {
      const start = Date.now()
      const s = await settingsGetter()
      const check = checkScope(s, "runtime:characters")
      if (!check.allowed) {
        await recordCall({
          tool: "resources/read:character",
          scope: "runtime:characters",
          check,
          latencyMs: Date.now() - start,
        })
        throw new Error(check.reason)
      }
      const parts = parseResourceUri(uri.href)
      if (!parts) {
        await recordCall({
          tool: "resources/read:character",
          scope: "runtime:characters",
          check: { allowed: false, reason: "malformed uri" },
          latencyMs: Date.now() - start,
        })
        throw new Error(`malformed resource uri '${uri.href}'`)
      }
      const character = await getCharacter(parts.id)
      if (!character) {
        await recordCall({
          tool: "resources/read:character",
          scope: "runtime:characters",
          check: { allowed: true },
          latencyMs: Date.now() - start,
        })
        throw new Error(`character '${parts.id}' not found`)
      }
      await recordCall({
        tool: "resources/read:character",
        scope: "runtime:characters",
        check: { allowed: true },
        latencyMs: Date.now() - start,
      })
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(character, null, 2) },
        ],
      }
    }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts — help external agents discover and use Cognia's tools.
// ─────────────────────────────────────────────────────────────────────────────

function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "cognia-howto",
    {
      title: "How to explore Cognia's codebase",
      description:
        "Guidance for coding agents on when and how to use Cognia's MCP tools " +
        "to understand the codebase, find relevant modules, and answer architecture questions.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "I want to explore the Cognia codebase. Please guide me on how to use your available tools.\n\n" +
              "Available tools:\n" +
              "- **wiki_search**: Find high-level module overviews by topic. Use this first to discover which modules exist.\n" +
              "- **wiki_read**: Read a full module article by slug (from wiki_search results). Use this when you need detailed API or internals info.\n" +
              "- **rag_search**: Fine-grained code retrieval at the section level. Use this when you need specific implementation details.\n" +
              "- **runtime_query**: List or get runtime entities (skills, characters, twins, plugins, agent-teams).\n\n" +
              "Resources (URI-based, auto-discovered by the client):\n" +
              "- `cognia://wiki/{slug}` — full wiki article as Markdown\n" +
              "- `cognia://skill/{id}` — skill definition as SKILL.md\n" +
              "- `cognia://character/{id}` — character config as JSON\n\n" +
              "Suggested workflow:\n" +
              "1. Start with `wiki_search` to find relevant modules by topic.\n" +
              "2. Use `wiki_read` on promising slugs to get the full article.\n" +
              "3. For implementation details, use `rag_search` for section-level retrieval.\n" +
              "4. Cross-reference with resources for skills and characters as needed.",
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "cognia-architecture",
    {
      title: "Understand Cognia's architecture",
      description:
        "A prompt that guides the agent through Cognia's layered architecture — " +
        "from the high-level module map down to specific subsystems.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "I need to understand Cognia's architecture. Please walk me through the major subsystems.\n\n" +
              "Start by running `wiki_search` with an empty query to get an overview of all modules, then drill into:\n" +
              "- **External Bridge** (`lib/external-bridge/`) — MCP server, permission gate, audit log\n" +
              "- **Wiki System** (`lib/wiki/`) — orchestrator, agents, Merkle engine, exporter\n" +
              "- **Twin** (`lib/twin/`) — ingest pipeline, distill agents, RAG runtime\n" +
              "- **Connectors** (`lib/connectors/`) — platform adapters, outbound runner, inbox\n" +
              "- **Claude Subscription** (`lib/anthropic-subscription/`) — OAuth flow, usage collection\n" +
              "- **Data** (`lib/data/`) — backup/restore, import/export, domain transfers\n\n" +
              "For each subsystem, use `wiki_read` to get the full article, then `rag_search` for specific implementation questions.",
          },
        },
      ],
    })
  )
}

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

export const __TESTING__ = { mapEntityToScope, runWithGate }
