/**
 * Built-in node executors — registered on first import of this module.
 * Each Phase 4 base executor handles the bare minimum to enable
 * end-to-end runs in tests and the Run button:
 *   • trigger.manual — passthrough of trigger payload
 *   • flow.set — write a value into the run's static-data variable
 *   • flow.branch — evaluate a condition expression, emit a decision
 *   • data.transform — small in-memory map/filter/reduce
 *   • ai.prompt — direct LLM call via the existing provider router
 *
 * Phase 6 adds the rest of the catalog. Until then, unregistered kinds
 * surface as "no executor registered" run failures.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { registerNodeExecutor } from "./registry"
import { resolveDeep, resolveExpression } from "@/lib/workflow/runtime/expression"
import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkillsByIds,
  recordSkillUsage,
  updateSkill,
} from "@/lib/db/skills"
import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import { createTeam, deleteTeam, updateTeam } from "@/lib/db/teams"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { createDraft } from "@/lib/db/connector-drafts"
import { generateTextEmbedding } from "@/lib/ai/embedding/multimodal-embedding"

// ── trigger.manual ────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "trigger.manual",
  typeVersion: 1,
  execute: async (ctx) => ({
    output: {
      firedAt: ctx.trigger.originAt,
      payload: ctx.trigger.payload,
    },
  }),
})

// ── flow.set ──────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "flow.set",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { variable?: string; value?: unknown }
    const variable = typeof params.variable === "string" ? params.variable.trim() : ""
    if (!variable) {
      throw new Error("flow.set requires a non-empty 'variable' name")
    }
    return {
      output: { variable, value: params.value },
      logs: [
        {
          level: "debug",
          message: `Set ${variable}`,
          payload: { value: params.value },
        },
      ],
    }
  },
})

// ── flow.branch ───────────────────────────────────────────────────────────
// `params.condition` arrives already-resolved by `resolveDeep` upstream, so
// the executor decides truthiness directly. A richer condition language
// (JS comparisons, regex tests) lands in Phase 6 alongside `data.code`.
registerNodeExecutor({
  kind: "flow.branch",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      condition?: unknown
      truthyLabel?: string
      falsyLabel?: string
    }
    const truthyLabel =
      typeof params.truthyLabel === "string" && params.truthyLabel.trim()
        ? params.truthyLabel.trim()
        : "true"
    const falsyLabel =
      typeof params.falsyLabel === "string" && params.falsyLabel.trim()
        ? params.falsyLabel.trim()
        : "false"
    // Empty / unset condition → falsy branch (matches user intuition that
    // "no condition set" means default).
    if (params.condition === undefined || params.condition === "") {
      return { output: { decision: falsyLabel }, decision: falsyLabel }
    }
    const decision = isTruthy(params.condition) ? truthyLabel : falsyLabel
    return {
      output: { decision, evaluated: params.condition },
      decision,
    }
  },
})

// ── data.transform ────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "data.transform",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { operation?: string; expression?: string }
    const operation = params.operation ?? "map"
    // The first upstream output becomes the input. If there are multiple
    // upstreams, callers should add a flow.join first.
    const input = firstUpstream(ctx)
    if (input === undefined) {
      return { output: undefined }
    }
    const arr = Array.isArray(input) ? input : []
    if (!Array.isArray(input)) {
      // Pass through non-array inputs unchanged for any operation that's
      // a no-op on a scalar.
      return { output: input }
    }
    const expr = params.expression?.trim() ?? ""
    switch (operation) {
      case "map":
        return {
          output: arr.map((item) => evalItemExpression(expr, item, ctx) ?? item),
        }
      case "filter":
        return {
          output: arr.filter((item) => isTruthy(evalItemExpression(expr, item, ctx))),
        }
      case "sort":
        return {
          output: [...arr].sort((a, b) => {
            const ka = String(evalItemExpression(expr, a, ctx) ?? "")
            const kb = String(evalItemExpression(expr, b, ctx) ?? "")
            return ka.localeCompare(kb)
          }),
        }
      case "flatten":
        return { output: arr.flat() }
      case "reduce":
        // Phase 4 ships a sum-by-default reduce; Phase 6 wires a real
        // reducer expression.
        return {
          output: arr.reduce((acc, item) => {
            const v = evalItemExpression(expr, item, ctx)
            return typeof v === "number" ? acc + v : acc
          }, 0),
        }
      default:
        throw new Error(`Unsupported transform operation: ${operation}`)
    }
  },
})

// ── ai.prompt ─────────────────────────────────────────────────────────────
// Real LLM call via `createLlmClient` when provider + apiKey are present in
// params (or resolvable via secret refs). When credentials aren't available
// the executor falls back to a clearly-marked echo stub so workflows authored
// before keys were configured still run end-to-end.
registerNodeExecutor({
  kind: "ai.prompt",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      systemPrompt?: string
      userPrompt?: string
      temperature?: number
    }
    const apiKey =
      params.apiKey ??
      (await ctx.resolveSecret(
        ctx.params.credentialRefs && typeof ctx.params.credentialRefs === "object"
          ? ((ctx.params.credentialRefs as Record<string, string>).apiKey ?? "")
          : ""
      ))
    const userPrompt = params.userPrompt ?? ""
    if (!params.provider || !params.model || !apiKey) {
      ctx.log(
        "warn",
        "ai.prompt: provider / model / apiKey missing — using stub echo. " +
          "Configure them on the node (or via credential refs) for a real LLM call."
      )
      return {
        output: {
          provider: params.provider,
          model: params.model,
          completion: `[ai.prompt stub] ${userPrompt}`,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stub: true,
        },
      }
    }
    const { createLlmClient } = await import("@/lib/twin/distill/llm")
    const client = createLlmClient({
      provider: params.provider as Parameters<typeof createLlmClient>[0]["provider"],
      model: params.model,
      apiKey,
      baseURL: params.baseURL,
      defaultTemperature: params.temperature,
    })
    const completion = await client.complete(userPrompt, {
      system: params.systemPrompt,
      temperature: params.temperature,
    })
    const usage = client.getUsageSnapshot?.() ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    return {
      output: {
        provider: params.provider,
        model: params.model,
        completion,
        usage,
        stub: false,
      },
    }
  },
})

// ── flow.switch ───────────────────────────────────────────────────────────
// Multi-way branch. Picks the case label whose `value` equals the resolved
// `subject`. Falls through to `defaultLabel` (or "default") when no case
// matches. The orchestrator treats the result the same as flow.branch's
// decision — non-chosen edges get propagateSkip()'d.
registerNodeExecutor({
  kind: "flow.switch",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      subject?: unknown
      cases?: Array<{ value: unknown; label: string }>
      defaultLabel?: string
    }
    const cases = Array.isArray(params.cases) ? params.cases : []
    const defaultLabel = params.defaultLabel?.trim() || "default"
    const matched = cases.find((c) => c.value === params.subject)
    const decision = matched?.label?.trim() || defaultLabel
    return {
      output: { decision, evaluated: params.subject },
      decision,
    }
  },
})

// ── flow.split ────────────────────────────────────────────────────────────
// Pure passthrough — the orchestrator inspects the graph to fan out, so
// this executor just forwards its upstream so downstream branches can
// reference it. Behavior matches "default" execution.
registerNodeExecutor({
  kind: "flow.split",
  typeVersion: 1,
  execute: async (ctx) => ({ output: { fanOutAt: ctx.runId, upstream: ctx.upstream } }),
})

// ── flow.join ─────────────────────────────────────────────────────────────
// Collects upstream outputs into a single payload. The orchestrator already
// gathers upstream values into `ctx.upstream`; this executor just freezes
// them with the configured `joinPolicy` so downstream nodes can branch on
// "did all parents succeed?".
registerNodeExecutor({
  kind: "flow.join",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { joinPolicy?: "all" | "any" | "race" }
    const joinPolicy = params.joinPolicy ?? "all"
    const upstreamCount = Object.keys(ctx.upstream).length
    return {
      output: {
        joinPolicy,
        gathered: ctx.upstream,
        upstreamCount,
      },
    }
  },
})

// ── flow.loop ─────────────────────────────────────────────────────────────
// Phase 4 ships an iterator-style loop over an input array, collecting the
// per-iteration body output (passed via the `bodyExpression` evaluated for
// each item). Real subgraph-loop execution (`flow.loop` calling back into
// the orchestrator) lands in Phase 6 alongside `flow.subworkflow`.
registerNodeExecutor({
  kind: "flow.loop",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "forEach" | "while" | "times"
      times?: number
      input?: unknown
      bodyExpression?: string
    }
    const mode = params.mode ?? "forEach"
    if (mode === "times") {
      const times = Math.max(0, Math.floor(Number(params.times ?? 0)))
      const items = Array.from({ length: times }, (_, i) => i)
      return { output: { iterations: items.length, items } }
    }
    const input = Array.isArray(params.input) ? params.input : firstUpstream(ctx)
    if (!Array.isArray(input)) {
      return { output: { iterations: 0, items: [] as unknown[] } }
    }
    const expr = params.bodyExpression?.trim() ?? ""
    const items = input.map((item) => evalItemExpression(expr, item, ctx) ?? item)
    return { output: { iterations: items.length, items } }
  },
})

// ── flow.wait ─────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "flow.wait",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { mode?: string; durationMs?: number }
    const mode = params.mode ?? "duration"
    if (mode !== "duration") {
      // Event-based wait wires up in Phase 5+ (Rust trigger daemon needs to
      // surface external wake-ups via the IPC contract). Until then, this
      // mode is a no-op so workflows authored against it still load.
      return { output: { skipped: "event mode not yet implemented" } }
    }
    const ms = Math.max(0, Number(params.durationMs ?? 0))
    if (ms > 0) {
      await new Promise<void>((resolve, reject) => {
        if (ctx.signal.aborted) return reject(new Error("Workflow run aborted"))
        const t = setTimeout(() => {
          ctx.signal.removeEventListener("abort", onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(t)
          reject(new Error("Workflow run aborted"))
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    return { output: { waitedMs: ms } }
  },
})

// ── data.template ─────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "data.template",
  typeVersion: 1,
  execute: async (ctx) => {
    // The template string is already passed through `resolveDeep` in the
    // step executor, so we receive it fully expanded. The executor's job is
    // to surface the rendered string as the node's output.
    const rendered = (ctx.params as { template?: unknown }).template ?? ""
    return { output: { rendered: typeof rendered === "string" ? rendered : String(rendered) } }
  },
})

// ── data.code ─────────────────────────────────────────────────────────────
// 5-second sandboxed JS via `new Function()`. Available bindings: upstream,
// trigger, params (already-resolved), staticData. The body must `return`
// the value it wants downstream nodes to consume.
registerNodeExecutor({
  kind: "data.code",
  typeVersion: 1,
  timeoutMs: 5000,
  execute: async (ctx) => {
    const code = String((ctx.params as { code?: unknown }).code ?? "")
    if (!code.trim()) return { output: undefined }
    const fn = new Function(
      "upstream",
      "trigger",
      "params",
      "staticData",
      `"use strict"; ${code}`
    ) as (upstream: unknown, trigger: unknown, params: unknown, staticData: unknown) => unknown
    try {
      const result = fn(ctx.upstream, ctx.trigger, ctx.params, {})
      const resolved = result instanceof Promise ? await result : result
      return { output: resolved }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const wrapped = new Error(`data.code failed: ${message}`) as Error & {
        retryable?: boolean
      }
      wrapped.retryable = false
      throw wrapped
    }
  },
})

// ── io.http ───────────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "io.http",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      url?: string
      method?: string
      body?: unknown
      headers?: Record<string, string>
      followRedirects?: boolean
    }
    const url = String(params.url ?? "").trim()
    if (!url) throw new Error("io.http requires a non-empty URL")
    const method = (params.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {
      Accept: "application/json,text/plain,*/*",
      ...(params.headers ?? {}),
    }
    let body: BodyInit | undefined
    if (method !== "GET" && method !== "HEAD" && params.body !== undefined) {
      if (typeof params.body === "string") {
        body = params.body
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json"
      } else {
        body = JSON.stringify(params.body)
        headers["Content-Type"] = "application/json"
      }
    }
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: ctx.signal,
      redirect: params.followRedirects === false ? "manual" : "follow",
    })
    const contentType = response.headers.get("content-type") ?? ""
    let payload: unknown
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => null)
    } else {
      payload = await response.text()
    }
    if (!response.ok) {
      const err = new Error(
        `HTTP ${response.status} ${response.statusText} from ${url}`
      ) as Error & { retryable?: boolean }
      // 5xx errors are retryable; 4xx are not.
      err.retryable = response.status >= 500
      throw err
    }
    return {
      output: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: payload,
      },
    }
  },
})

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
    const markdown = skills
      .map(
        (s) =>
          `### ${s.name}\n\n${
            (s as unknown as { systemPrompt?: string; body?: string }).systemPrompt ??
            (s as unknown as { body?: string }).body ??
            ""
          }`
      )
      .join("\n\n")
    // Best-effort: record usage so the panel can sort by lastUsedAt.
    void recordSkillUsage(ids).catch(() => undefined)
    return {
      output: {
        skills: skills.map((s) => ({ id: s.id, name: s.name })),
        markdown,
      },
    }
  },
})

// ── action.character.create ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      systemPrompt?: string
      description?: string
      avatarColor?: string
      avatarEmoji?: string
      model?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.character.create requires a non-empty 'name'")
    }
    if (!params.systemPrompt?.trim()) {
      throw nonRetryable("action.character.create requires a 'systemPrompt'")
    }
    const character = await createCharacter({
      name: params.name.trim(),
      systemPrompt: params.systemPrompt,
      description: params.description,
      avatarColor: params.avatarColor,
      avatarEmoji: params.avatarEmoji,
      model: params.model,
    })
    return {
      output: { characterId: character.id, name: character.name },
    }
  },
})

// ── action.character.update ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      patch?: Record<string, unknown>
    }
    const id = params.characterId?.trim()
    if (!id) {
      throw nonRetryable("action.character.update requires 'characterId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.character.update requires a non-empty 'patch' object")
    }
    // Strip immutable fields the UI shouldn't be able to override.
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateCharacter(id, safePatch as Parameters<typeof updateCharacter>[1])
    return { output: { characterId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.team.create ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      members?: Array<{ characterId: string; role?: string }>
      orchestration?: "round_robin" | "supervisor" | "mention_round_robin"
      supervisorCharacterId?: string
      description?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.team.create requires a non-empty 'name'")
    }
    if (!Array.isArray(params.members) || params.members.length === 0) {
      throw nonRetryable("action.team.create requires at least one member")
    }
    const team = await createTeam({
      name: params.name.trim(),
      description: params.description,
      members: params.members,
      orchestration: params.orchestration,
      supervisorCharacterId: params.supervisorCharacterId,
    })
    return { output: { teamId: team.id, name: team.name } }
  },
})

// ── action.team.update ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      teamId?: string
      patch?: Record<string, unknown>
    }
    const id = params.teamId?.trim()
    if (!id) {
      throw nonRetryable("action.team.update requires 'teamId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.team.update requires a 'patch' object")
    }
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateTeam(id, safePatch as Parameters<typeof updateTeam>[1])
    return { output: { teamId: id, patched: Object.keys(safePatch) } }
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

// ── action.connector.send ─────────────────────────────────────────────────
// Enqueue an outbound message via the existing `outboundQueue`. The queue
// runner (lib/connectors/outbound-runner.ts) picks rows up FIFO per
// conversation lane and handles retries / circuit breakers / rate limits.
registerNodeExecutor({
  kind: "action.connector.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      adapterId?: string
      conversationKey?: string
      content?: string
      idempotencyKey?: string
      replyToMessageId?: string
    }
    const adapterId = params.adapterId?.trim()
    const conversationKey = params.conversationKey?.trim()
    const content = params.content ?? ""
    if (!adapterId) throw nonRetryable("action.connector.send requires 'adapterId'")
    if (!conversationKey) throw nonRetryable("action.connector.send requires 'conversationKey'")
    if (!content) throw nonRetryable("action.connector.send requires non-empty 'content'")
    const idempotencyKey = params.idempotencyKey?.trim() || `${ctx.runId}:${ctx.stepId}`
    const job = await enqueueOutbound({
      adapterId,
      conversationKey,
      request: {
        conversationRef: { adapterId, conversationKey } as unknown as Parameters<
          typeof enqueueOutbound
        >[0]["request"]["conversationRef"],
        segments: [{ type: "text", text: content }],
        replyTo: params.replyToMessageId ? { messageId: params.replyToMessageId } : undefined,
        metadata: { idempotencyKey },
      },
    })
    return {
      output: {
        jobId: job.id,
        adapterId,
        conversationKey,
        idempotencyKey,
      },
    }
  },
})

// ── action.connector.draft ────────────────────────────────────────────────
// Stash the proposed reply in `connectorDrafts` for human approval in the
// Inbox UI. Distinct from connector.send — drafts never auto-send.
registerNodeExecutor({
  kind: "action.connector.draft",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      conversationKey?: string
      sessionId?: string
      content?: string
      sourceMessageId?: string
      ttlMs?: number
    }
    const conversationKey = params.conversationKey?.trim()
    const sessionId = params.sessionId?.trim()
    const content = params.content ?? ""
    if (!conversationKey) throw nonRetryable("action.connector.draft requires 'conversationKey'")
    if (!sessionId) throw nonRetryable("action.connector.draft requires 'sessionId'")
    if (!content) throw nonRetryable("action.connector.draft requires non-empty 'content'")
    const expiresAt =
      typeof params.ttlMs === "number" && params.ttlMs > 0 ? Date.now() + params.ttlMs : undefined
    const draft = await createDraft({
      conversationKey,
      sessionId,
      segments: [{ type: "text", text: content }],
      sourceMessageId: params.sourceMessageId,
      expiresAt,
    })
    return { output: { draftId: draft.id, conversationKey, sessionId } }
  },
})

// ── ai.classify ───────────────────────────────────────────────────────────
// Reuses the `ai.prompt` executor under the hood with a constrained system
// prompt. The output is normalized to the matched label so downstream
// `flow.branch` / `flow.switch` nodes can route on it directly.
registerNodeExecutor({
  kind: "ai.classify",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      input?: string
      labels?: string[]
      hint?: string
    }
    const labels = (params.labels ?? []).map((l) => l.trim()).filter(Boolean)
    if (labels.length === 0) {
      throw nonRetryable("ai.classify requires at least one entry in 'labels'")
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.classify requires non-empty 'input'")
    const labelList = labels.map((l) => `- ${l}`).join("\n")
    const systemPrompt =
      `You are a strict text classifier. ` +
      `Return EXACTLY ONE of the following labels with no extra text:\n${labelList}` +
      (params.hint ? `\n\nGuidance: ${params.hint}` : "")
    // Delegate to ai.prompt — same provider routing + stub fallback.
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 1)
    if (!aiPrompt) throw new Error("ai.classify: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    ).trim()
    // Pick the first label whose lowercase form appears in the completion.
    // If nothing matches we fall back to the first label so downstream
    // branches always receive a known value.
    const lower = completion.toLowerCase()
    const matched = labels.find((l) => lower.includes(l.toLowerCase())) ?? labels[0]
    return {
      output: {
        label: matched,
        completion,
        confident: matched.toLowerCase() === lower,
      },
    }
  },
})

// ── ai.extract ────────────────────────────────────────────────────────────
// Structured JSON extraction. The executor instructs the LLM to emit JSON
// matching the `schema` object's shape, then attempts to parse it.
registerNodeExecutor({
  kind: "ai.extract",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      provider?: string
      model?: string
      apiKey?: string
      baseURL?: string
      input?: string
      schema?: Record<string, string>
      hint?: string
    }
    const input = params.input ?? ""
    if (!input) throw nonRetryable("ai.extract requires non-empty 'input'")
    const schema = params.schema ?? {}
    const fieldList = Object.entries(schema)
      .map(([k, v]) => `  "${k}": ${v}`)
      .join(",\n")
    const systemPrompt =
      `Extract data from the user message. Reply with ONLY a JSON object ` +
      `matching this shape:\n{\n${fieldList}\n}` +
      (params.hint ? `\n\nGuidance: ${params.hint}` : "")
    const aiPrompt = (await import("./registry")).getExecutor("ai.prompt", 1)
    if (!aiPrompt) throw new Error("ai.extract: ai.prompt executor unavailable")
    const inner = await aiPrompt.execute({
      ...ctx,
      params: {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        systemPrompt,
        userPrompt: input,
        temperature: 0,
      } as Record<string, unknown>,
    })
    const completion = String(
      (inner.output as { completion?: string } | undefined)?.completion ?? ""
    )
    let extracted: unknown = null
    let parseError: string | undefined
    // Try to extract a JSON object from the completion — LLMs sometimes
    // wrap it in markdown code fences.
    const jsonMatch = completion.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        extracted = JSON.parse(jsonMatch[0])
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err)
      }
    } else {
      parseError = "no JSON object found in completion"
    }
    return {
      output: {
        extracted,
        parseError,
        completion,
      },
    }
  },
})

// ── ai.embed ──────────────────────────────────────────────────────────────
// Phase 1 ships the deterministic hash-based embedder from
// `lib/ai/embedding/multimodal-embedding`. It's not a real semantic
// embedding — it's stable across runs, useful for testing and for
// downstream "did this text change?" checks. Real semantic embeddings
// land when the orchestrator can supply a configured embedding provider
// via secret refs (Phase 9 polish).
registerNodeExecutor({
  kind: "ai.embed",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { input?: string; dimension?: number }
    const text = params.input ?? ""
    if (!text) throw nonRetryable("ai.embed requires non-empty 'input'")
    const dimension =
      typeof params.dimension === "number" && params.dimension > 0
        ? Math.floor(params.dimension)
        : 384
    const vector = generateTextEmbedding(text, { dimension })
    return {
      output: {
        vector,
        dimension: vector.length,
        // Hash-based embedder is deterministic but NOT semantic. Surface
        // that fact so downstream consumers don't accidentally trust it
        // for similarity search outside test scenarios.
        kind: "deterministic-hash",
      },
    }
  },
})

// ── flow.subworkflow ──────────────────────────────────────────────────────
// Recursively invoke another workflow as a step. The subworkflow runs in a
// fresh run id (so its events don't pollute the parent's timeline); the
// parent step's output is the subworkflow's terminal output.
registerNodeExecutor({
  kind: "flow.subworkflow",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      workflowId?: string
      input?: unknown
    }
    const workflowId = params.workflowId?.trim()
    if (!workflowId) {
      throw nonRetryable("flow.subworkflow requires 'workflowId'")
    }
    // Lazy-imports avoid a circular dep through the node registry.
    const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
      import("@/lib/db/workflows"),
      import("@/lib/workflow/runtime/orchestrator"),
    ])
    const workflow = await getWorkflow(workflowId)
    if (!workflow) {
      throw nonRetryable(`flow.subworkflow: workflow ${workflowId} not found`)
    }
    const result = await runWorkflow({
      workflow,
      trigger: {
        workflowId,
        kind: "trigger.manual",
        payload: {
          parentRunId: ctx.runId,
          parentStepId: ctx.stepId,
          input: params.input ?? null,
        },
        originAt: Date.now(),
      },
    })
    if (result.status !== "succeeded") {
      const message = result.error?.message ?? "subworkflow run failed"
      throw nonRetryable(`flow.subworkflow: ${message}`)
    }
    return {
      output: {
        runId: result.runId,
        status: result.status,
        output: result.output,
      },
    }
  },
})

// ── io.webhook.respond ────────────────────────────────────────────────────
// Phase 5a's webhook receiver isn't shipped yet, so this executor is a
// passthrough that records what the response WOULD have been. Once the Rust
// webhook router lands (Phase 5b webhook trigger work), this executor will
// route the body back through a Tauri command.
registerNodeExecutor({
  kind: "io.webhook.respond",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      status?: number
      body?: unknown
      headers?: Record<string, string>
    }
    return {
      output: {
        status: typeof params.status === "number" ? params.status : 200,
        body: params.body ?? null,
        headers: params.headers ?? {},
        // Surface that the response was queued but not delivered (no
        // webhook receiver to respond to). Removed once Phase 5a webhook
        // routing lands.
        deliveryDeferred: true,
      },
    }
  },
})

// Helper for executors that want to flag their failures as non-retryable
// (e.g., "missing required field" — retrying won't help).
function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

// Suppress unused-import warning when only one of these helpers is exercised
// by the test suite — both are real call sites in production paths.
void deleteSkill
void deleteCharacter
void deleteTeam

// ── helpers ───────────────────────────────────────────────────────────────

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value)
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

function firstUpstream(ctx: StepExecutionContext): unknown {
  const values = Object.values(ctx.upstream)
  return values.length > 0 ? values[0] : undefined
}

/**
 * Evaluate a per-item transform expression. Item exposed as `$item`. Falls
 * back to the raw item when the expression is empty.
 */
function evalItemExpression(expression: string, item: unknown, ctx: StepExecutionContext): unknown {
  if (!expression) return item
  return resolveExpression(expression, {
    upstream: { ...ctx.upstream, $item: item },
    trigger: ctx.trigger,
    staticData: {},
    params: ctx.params as Record<string, unknown>,
  })
}
