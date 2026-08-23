import { registerNodeExecutor } from "../registry"
import {
  createSkill,
  getSkill,
  listSkillsByIds,
  recordSkillUsage,
  updateSkill,
} from "@/lib/db/skills"
import { getSkill as getPluginSkill } from "@/lib/plugin/registries/skill-registry"
import { invokeMcpTool } from "@/lib/mcp/invoke"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { generateSafeEmbedding } from "@/lib/rag/safe-embedding"
import { nonRetryable, sha256Hex } from "../shared/executor-support"

// ── action.skill.invoke ───────────────────────────────────────────────────
// Resolves a comma-separated list of skill ids into a single concatenated
// markdown body, ready for downstream AI prompts to splice into their
// systemPrompt. Records usage via `recordSkillUsage` so the "Recent" filter
// in Settings → Skills updates.
registerNodeExecutor({
  kind: "action.skill.invoke",
  typeVersion: 1,
  execute: async (ctx) => {
    const raw = String((ctx.params as { skillIds?: unknown }).skillIds ?? "")
    const ids = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) {
      return { output: { skills: [], markdown: "" } }
    }
    const skills = await listSkillsByIds(ids)
    const resolved = skills.map((s) => ({
      id: s.id,
      name: s.name,
      markdown:
        (s as unknown as { systemPrompt?: string; body?: string }).systemPrompt ??
        (s as unknown as { body?: string }).body ??
        "",
    }))
    // Fall back to plugin-contributed skills (skill-registry overlay) for any
    // ids the Dexie table didn't resolve. Inline-source skills carry their
    // markdown directly; folder/managed sources resolve elsewhere, so we
    // surface the name without a body here.
    const dbIds = new Set(skills.map((s) => s.id))
    for (const id of ids) {
      if (dbIds.has(id)) continue
      const def = getPluginSkill(id)
      if (!def) continue
      resolved.push({
        id: def.id,
        name: def.name,
        markdown: def.source.kind === "inline" ? def.source.markdown : "",
      })
    }
    const markdown = resolved.map((s) => `### ${s.name}\n\n${s.markdown}`).join("\n\n")
    // Best-effort: record usage so the panel can sort by lastUsedAt.
    void recordSkillUsage(ids).catch(() => undefined)
    return {
      output: {
        skills: resolved.map((s) => ({ id: s.id, name: s.name })),
        markdown,
      },
    }
  },
})

// ── action.skill.upsert ───────────────────────────────────────────────────
// "upsert" — create when no `skillId`, update otherwise. Allows workflows to
// idempotently keep a skill in sync without branching on existence.
registerNodeExecutor({
  kind: "action.skill.upsert",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      skillId?: string
      name?: string
      content?: string
      description?: string
      tags?: string[]
    }
    if (params.skillId?.trim()) {
      const id = params.skillId.trim()
      const existing = await getSkill(id)
      if (!existing) {
        throw nonRetryable(`action.skill.upsert: skill ${id} not found`)
      }
      const patch: Parameters<typeof updateSkill>[1] = {}
      if (params.name !== undefined) patch.name = params.name.trim() || existing.name
      if (params.content !== undefined) patch.content = params.content
      if (params.description !== undefined) patch.description = params.description
      if (params.tags !== undefined) patch.tags = params.tags
      await updateSkill(id, patch)
      return { output: { skillId: id, action: "updated" } }
    }
    if (!params.name?.trim() || params.content === undefined) {
      throw nonRetryable(
        "action.skill.upsert: when 'skillId' is absent, 'name' and 'content' are required"
      )
    }
    const skill = await createSkill({
      name: params.name.trim(),
      content: params.content,
      description: params.description,
      tags: params.tags,
    })
    return { output: { skillId: skill.id, action: "created" } }
  },
})

// ── action.memory.recall / action.memory.store ───────────────────────────
// Long-term memory access (lib/memory). Recall is read-only and best-effort
// (degrades, never throws on a missing backend); store mirrors /remember's
// explicit-capture path through the shared consolidator with a mandatory
// PII gate. Store is not retryable (it writes).
registerNodeExecutor({
  kind: "action.memory.recall",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => (await import("../actions/memory-recall")).runMemoryRecall(ctx),
})

registerNodeExecutor({
  kind: "action.memory.store",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/memory-store")).runMemoryStore(ctx),
})

// ── action.twin.rag ───────────────────────────────────────────────────────
// Vector-search the twin's chunks. Returns the top-K chunks with score and
// source metadata. Degrades gracefully when the vector store / embedding
// config is incomplete — surfaces the reason in the output rather than
// throwing, so workflows can decide whether to fail fast or carry on.
registerNodeExecutor({
  kind: "action.twin.rag",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { twinId?: string; query?: string; topK?: number }
    const twinId = params.twinId?.trim()
    const query = params.query ?? ""
    if (!twinId) throw nonRetryable("action.twin.rag requires 'twinId'")
    if (!query.trim()) throw nonRetryable("action.twin.rag requires non-empty 'query'")
    const topK = Math.max(1, Math.min(50, Math.floor(Number(params.topK ?? 6))))

    const [
      { tryBuildTwinDeps },
      { vectorCollectionName },
      { getTwinChunksByVectorDocIds },
      { getTwinSource },
    ] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/twin/ingest/persist"),
      import("@/lib/db/twin-chunks"),
      import("@/lib/db/twin-sources"),
    ])

    const deps = await tryBuildTwinDeps()
    if (!deps) {
      return {
        output: {
          chunks: [],
          degraded: true,
          reason: "twin runtime not configured (embedding / vector store missing)",
        },
      }
    }

    let queryEmbedding: number[]
    try {
      const embedded = await generateSafeEmbedding(query, {
        profileId: `workflow-twin:${twinId}`,
        purpose: "query",
        embedding: deps.embedding,
        vectorBackend: deps.vectorBackend ?? "native",
      })
      queryEmbedding = embedded.embedding
    } catch (err) {
      return {
        output: {
          chunks: [],
          degraded: true,
          reason: err instanceof Error ? `embed-failed: ${err.message}` : "embed-failed",
        },
      }
    }

    const collection = vectorCollectionName(twinId)
    const search = deps.store.searchByEmbedding
    if (!search) {
      return {
        output: { chunks: [], degraded: true, reason: "store.searchByEmbedding unavailable" },
      }
    }

    const hits = await search(collection, queryEmbedding, { limit: topK })
    const docIds = hits.map((h) => h.id)
    const dbChunks = await getTwinChunksByVectorDocIds(docIds)
    const chunkById = new Map(dbChunks.map((c) => [c.vectorDocId, c]))
    const titleCache = new Map<string, string | undefined>()
    const enriched: Array<{
      id: string
      score: number
      content: string
      sourceId: string
      sourceTitle?: string
    }> = []
    for (const h of hits) {
      const chunk = chunkById.get(h.id)
      if (!chunk) continue
      let title = titleCache.get(chunk.sourceId)
      if (title === undefined) {
        const src = await getTwinSource(chunk.sourceId)
        title = src?.title
        titleCache.set(chunk.sourceId, title)
      }
      enriched.push({
        id: h.id,
        score: h.score,
        content: chunk.content,
        sourceId: chunk.sourceId,
        sourceTitle: title,
      })
    }
    return { output: { chunks: enriched, count: enriched.length, degraded: false } }
  },
})

// ── action.twin.ingest ────────────────────────────────────────────────────
// Queue a new TwinSource into the ingest pipeline. The job worker picks it
// up asynchronously; this executor returns once the job is queued (not
// once it's finalized). Use `flow.wait` + a job-poll downstream if you need
// to block until the source is fully embedded.
registerNodeExecutor({
  kind: "action.twin.ingest",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      twinId?: string
      title?: string
      format?: string
      content?: string
      sourceMode?: "paste" | "fetch"
      url?: string
    }
    const twinId = params.twinId?.trim()
    if (!twinId) throw nonRetryable("action.twin.ingest requires 'twinId'")
    const format = (params.format ?? "markdown") as "markdown" | "text" | "code" | "chat"
    const sourceMode = params.sourceMode ?? "paste"
    let content = params.content ?? ""
    if (sourceMode === "fetch") {
      const url = params.url?.trim()
      if (!url) throw nonRetryable("twin.ingest fetch mode requires 'url'")
      // `proxyFetch`: an author-supplied ingest URL is never on `connect-src`.
      const res = await proxyFetch(url, { signal: ctx.signal })
      if (!res.ok) {
        const err = new Error(`twin.ingest fetch ${url} → ${res.status}`) as Error & {
          retryable?: boolean
        }
        err.retryable = res.status >= 500
        throw err
      }
      content = await res.text()
    }
    if (!content) throw nonRetryable("twin.ingest requires non-empty content")

    const [{ createTwinSource }, { createTwinJob }] = await Promise.all([
      import("@/lib/db/twin-sources"),
      import("@/lib/db/twin-jobs"),
    ])

    // Compute the required source metadata that TwinSourceDraft mandates.
    const bytes = new TextEncoder().encode(content).length
    const fingerprint = await sha256Hex(content)
    const source = await createTwinSource({
      twinId,
      kind: format === "code" ? "code" : format === "chat" ? "chat" : "doc",
      format,
      source: sourceMode === "fetch" ? (params.url ?? "manual") : "manual",
      title: params.title || `Workflow ingest ${ctx.stepId}`,
      bytes,
      fingerprint,
      status: "pending",
    } as unknown as Parameters<typeof createTwinSource>[0])
    const job = await createTwinJob({
      twinId,
      kind: "ingest",
      sourceId: source.id,
    } as unknown as Parameters<typeof createTwinJob>[0])
    return {
      output: {
        twinId,
        sourceId: source.id,
        jobId: job.id,
        status: "queued",
      },
    }
  },
})

// ── action.mcp.invokeTool ─────────────────────────────────────────────────
// Spin up a one-shot MCP client connected to the server identified by
// `serverId`, call the tool, and return its content. Stdio transport uses
// the configured command + args; HTTP / SSE servers use the configured URL.
registerNodeExecutor({
  kind: "action.mcp.invokeTool",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      serverId?: string
      toolName?: string
      args?: Record<string, unknown>
      piiGate?: "block" | "redact"
    }
    const serverId = params.serverId?.trim()
    const toolName = params.toolName?.trim()
    if (!serverId) throw nonRetryable("action.mcp.invokeTool requires 'serverId'")
    if (!toolName) throw nonRetryable("action.mcp.invokeTool requires 'toolName'")
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<
      string,
      unknown
    >

    // Presets are installation templates only. Runtime execution requires a
    // stored Registry row that has crossed the common trust policy.
    const { getMcpServer } = await import("@/lib/db/mcp-servers")
    const server = await getMcpServer(serverId)
    if (!server) throw nonRetryable(`MCP server ${serverId} not found`)
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: server.transport === "stdio" ? "local-tool" : "remote-tool",
      requestedMode: params.piiGate,
      value: args,
    })
    const safeArgs = guarded.value

    const { getPluginEventHooks } = await import("@/lib/plugin")
    const hooks = getPluginEventHooks()

    try {
      hooks.dispatchMCPServerConnect(serverId, server.name)
      hooks.dispatchMCPToolCall(serverId, toolName, safeArgs)
      // Shared invoke seam: correct stdio/sse/http split + static headers +
      // (future) OAuth authProvider. Inject the already-resolved server so we
      // don't re-hit Dexie / the preset registry.
      const result = await invokeMcpTool(
        {
          serverId,
          toolName,
          args: safeArgs,
          signal: ctx.signal,
          scopeId: `run:${ctx.runId}`,
          surface: "workflow",
          clientInfo: { name: "cognia-workflow", version: "1.0.0" },
        },
        { getServer: async () => server }
      )
      hooks.dispatchMCPToolResult(serverId, toolName, {
        isError: result.isError,
        content: result.content,
        structuredContent: result.structuredContent,
      })
      return {
        output: {
          serverId,
          toolName,
          isError: result.isError,
          content: result.content,
          structuredContent: result.structuredContent,
          ...(guarded.redacted ? { piiRedacted: true } : {}),
        },
      }
    } finally {
      hooks.dispatchMCPServerDisconnect(serverId)
    }
  },
})

// ── action.plugin.invoke ──────────────────────────────────────────────────
// Two dispatch modes, inferred for persisted-node back-compat:
//
//  - "tool" (new, UI default): invokes a plugin-registered agent tool
//    (`ctx.agent.registerTool()` / manifest `tools[]`) through the unified
//    `invokePluginTool` seam — the same path the chat agent's sidecar
//    round-trip uses, so lazy `onTool:` activation and the permission
//    consent gate behave identically.
//  - "task" (legacy, ADR-0017): dispatches to a `workflow.task` extension
//    registered under the plugin id. Kept verbatim so existing nodes and
//    the formalized extension path stay valid.
//
// The registration deliberately stays at typeVersion 1: executor lookup is
// an exact `(kind, typeVersion)` match with no fallback
// (`lib/workflow/runtime/step-executor.ts`), so a bump would orphan every
// persisted v1 node, and the params change is purely additive.
registerNodeExecutor({
  kind: "action.plugin.invoke",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      pluginId?: string
      mode?: "task" | "tool"
      toolName?: string
      taskId?: string
      args?: Record<string, unknown>
      piiGate?: "block" | "redact"
    }
    const pluginId = params.pluginId?.trim()
    const toolName = params.toolName?.trim()
    const taskId = params.taskId?.trim()
    if (!pluginId) throw nonRetryable("action.plugin.invoke requires 'pluginId'")
    const mode = params.mode ?? (toolName ? "tool" : "task")
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Record<
      string,
      unknown
    >

    const { getPlugin } = await import("@/lib/db/plugins")
    const plugin = await getPlugin(pluginId)
    if (!plugin) throw nonRetryable(`plugin ${pluginId} not found`)
    const permissions = Array.isArray(plugin.manifest.permissions)
      ? plugin.manifest.permissions.filter(
          (permission): permission is string => typeof permission === "string"
        )
      : []
    const hasNetworkEgress =
      permissions.includes("network:fetch") || plugin.manifest.networkAccess !== undefined
    const guarded = guardWorkflowEgress({
      securityContext: ctx.securityContext,
      sink: hasNetworkEgress ? "remote-tool" : "local-tool",
      requestedMode: params.piiGate,
      value: args,
    })
    const safeArgs = guarded.value

    if (mode === "tool") {
      if (!toolName) {
        throw nonRetryable("action.plugin.invoke (tool mode) requires 'toolName'")
      }
      const { invokePluginTool, PluginToolInvocationError } =
        await import("@/lib/plugin/core/invoke-plugin-tool")
      try {
        const { result } = await invokePluginTool(pluginId, toolName, safeArgs, {
          signal: ctx.signal,
          reason: "workflow:action.plugin.invoke",
        })
        return {
          output: {
            pluginId,
            toolName,
            ok: true,
            data: result,
            ...(guarded.redacted ? { piiRedacted: true } : {}),
          },
        }
      } catch (err) {
        if (err instanceof PluginToolInvocationError) {
          // Configuration/permission failures won't heal on retry; runtime
          // failures (execution-failed / aborted) stay retryable.
          if (
            err.code === "plugin-not-found" ||
            err.code === "plugin-disabled" ||
            err.code === "tool-not-found" ||
            err.code === "permission-denied"
          ) {
            throw nonRetryable(err.message)
          }
        }
        throw err
      }
    }

    if (!taskId) throw nonRetryable("action.plugin.invoke requires 'taskId'")

    if (!plugin.enabled) {
      throw nonRetryable(`plugin ${pluginId} is not enabled`)
    }

    // Plugin task invocation goes through the extension API: the plugin must
    // have registered a workflow-task extension under its plugin id.
    const { getPluginExtensions } = await import("@/lib/plugin/api/extension-api")
    const exts = getPluginExtensions(pluginId)
    type WorkflowTaskExtension = {
      point: string
      registration: {
        task?: string
        handler?: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
      }
    }
    const candidate = (exts as unknown as WorkflowTaskExtension[]).find(
      (e) => e.point === "workflow.task" && e.registration?.task === taskId
    )
    if (!candidate?.registration?.handler) {
      throw nonRetryable(
        `plugin ${pluginId} has no workflow.task '${taskId}' registered. ` +
          `Plugins must add a workflow.task extension to be invokable.`
      )
    }
    const data = await candidate.registration.handler(safeArgs, ctx.signal)
    return {
      output: {
        pluginId,
        taskId,
        ok: true,
        data,
        ...(guarded.redacted ? { piiRedacted: true } : {}),
      },
    }
  },
})
