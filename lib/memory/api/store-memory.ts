/**
 * Shared deliberate-write path for the long-term memory store — the single
 * implementation behind every non-conversational write surface: the workflow
 * `action.memory.store` node, the plugin `ctx.memory.store` API, the MCP
 * bridge `memory_store` tool, and the companion RPC `memory_store` command.
 *
 * Mirrors the `/remember` explicit-capture contract: the text IS the memory
 * (no extraction LLM), but it still flows through the SAME consolidator so it
 * dedupes / updates / supersedes instead of blindly piling up. When no utility
 * LLM client is available it degrades to a direct Dexie insert + best-effort
 * vector upsert (`consolidated: false`) — the memory is never silently dropped.
 *
 * Trust model (ADR-0069):
 *   - `procedural` requires `user`/`explicit` provenance — API surfaces and
 *     automated workflows may not silently rewrite agent behavior.
 *   - The PII gate is mandatory. External surfaces get "block" only (they
 *     cannot consent to redaction on the user's behalf); the workflow node
 *     additionally supports "redact".
 *   - Policy blocks (disabled / temporary / PII) return a structured result;
 *     caller programming errors (empty text, bad scope combo, untrusted
 *     procedural) throw.
 */

import type {
  MemoryProvenance,
  MemoryScope,
  MemorySourceChannel,
  MemoryType,
} from "@/types/memory/memory"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"

export interface MemoryAttribution {
  channel: MemorySourceChannel
  /** Set when `channel === "plugin"`. */
  pluginId?: string
}

export interface StoreMemoryCoreInput {
  text: string
  scope?: MemoryScope
  /** Required when `scope === "character"`. */
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  type?: MemoryType
  /** Stable key for procedural dedupe / "always X" overrides. */
  key?: string
  /** 1..10, clamped (default 7 — /remember's explicit-capture weight). */
  importance?: number
  tags?: string[]
  provenance: MemoryProvenance
  /** PII gate mode; external surfaces must use "block". */
  piiGate?: "block" | "redact"
  source?: { sessionId?: string; messageId?: string }
  attribution?: MemoryAttribution
}

export type StoreMemoryCoreResult =
  | {
      ok: true
      /** False when the consolidator judged the fact already captured (NOOP). */
      stored: boolean
      consolidated: boolean
      /** The ADDed row's id (absent on UPDATE/NOOP outcomes). */
      memoryId?: string
      applied: ConsolidationOp["op"][]
      piiRedacted?: boolean
    }
  | { ok: false; reason: "disabled" | "temporary" | "pii_blocked" }

export function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 7
  return Math.min(10, Math.max(1, Math.round(value)))
}

export async function storeMemoryCore(input: StoreMemoryCoreInput): Promise<StoreMemoryCoreResult> {
  const rawText = input.text.trim()
  if (!rawText) throw new Error("memory store requires a non-empty 'text'")
  const scope = input.scope ?? "global"
  if (scope === "character" && !input.characterId) {
    throw new Error("memory store: 'characterId' is required when scope is 'character'")
  }
  if (scope === "workspace" && !input.projectId) {
    throw new Error("memory store: 'projectId' is required when scope is 'workspace'")
  }
  if (scope === "agent" && !input.agentId) {
    throw new Error("memory store: 'agentId' is required when scope is 'agent'")
  }
  const type: MemoryType = input.type ?? "semantic"
  if (type === "procedural" && input.provenance !== "user" && input.provenance !== "explicit") {
    throw new Error(
      "memory store: procedural memories require user/explicit provenance — " +
        "API surfaces and automated workflows may not silently rewrite agent behavior."
    )
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) return { ok: false, reason: "disabled" }
  if (config.temporary) return { ok: false, reason: "temporary" }

  // PII gate — mandatory on the write path (memory text persists durably).
  const { hasNoLeakingPii, redactText } = await import("@cognia/redact")
  let text = rawText
  let piiRedacted = false
  if ((input.piiGate ?? "block") === "block") {
    if (!hasNoLeakingPii(rawText)) return { ok: false, reason: "pii_blocked" }
  } else {
    const result = redactText(rawText)
    text = result.redacted
    piiRedacted = Object.keys(result.map).length > 0
    if (!hasNoLeakingPii(text)) return { ok: false, reason: "pii_blocked" }
  }

  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const candidate = {
    type,
    text,
    importance: clampImportance(input.importance),
    ...(input.key ? { key: input.key } : {}),
  }
  const characterId = scope === "character" ? input.characterId : undefined
  const projectId = input.projectId
  const agentId = scope === "agent" ? input.agentId : undefined

  // Preferred path: the shared consolidator (dedupe / ADD / UPDATE / DELETE).
  const { buildAutoExtractionDeps } = await import("@/lib/memory/write/run-memory-extraction")
  const deps = await buildAutoExtractionDeps({ session: null, appSettings: settings }, config)
  const memDb = await import("@/lib/db/memories")
  if (deps) {
    const { applied } = await deps.consolidate({
      candidates: [candidate],
      scope,
      characterId,
      projectId,
      agentId,
      branch: input.branch,
      pathPattern: input.pathPattern,
      provenance: input.provenance,
      source: input.source,
      attribution: input.attribution,
    })
    // Tags ride as a post-ADD patch — the consolidator's candidate shape is
    // shared with LLM extraction, which never produces tags.
    if (tags.length > 0) {
      for (const op of applied) {
        if (op.op === "ADD" && op.memory?.id) {
          try {
            await memDb.updateMemory(op.memory.id, { tags })
          } catch {
            // Best-effort — the memory row itself already landed.
          }
        }
      }
    }
    const added = applied.find(
      (op): op is Extract<ConsolidationOp, { op: "ADD" | "CONFLICT" }> =>
        op.op === "ADD" || op.op === "CONFLICT"
    )
    const memoryId = added?.memory?.id
    const governedIds = applied.flatMap((op) => {
      if (op.op === "ADD" || op.op === "CONFLICT") return [op.memory.id]
      if (op.op === "UPDATE") return [op.targetId]
      return []
    })
    if (governedIds.length > 0) {
      try {
        const governance = await import("@/lib/db/memory-governance")
        for (const id of governedIds) {
          await memDb.updateMemory(id, {
            evidenceState: "supported",
            reviewStatus: applied.some((op) => op.op === "CONFLICT" && op.memory.id === id)
              ? "conflict"
              : input.provenance === "explicit"
                ? "verified"
                : "unreviewed",
            contaminationState: input.provenance === "external" ? "external-context" : "clean",
            sensitivity: "normal",
          })
          await governance.createMemoryEvidence({
            memoryId: id,
            kind: input.provenance === "external" ? "external" : "manual",
            sourceId:
              input.source?.messageId ??
              input.source?.sessionId ??
              input.attribution?.pluginId ??
              input.attribution?.channel ??
              `manual:${id}`,
            sessionId: input.source?.sessionId,
            messageId: input.source?.messageId,
            contaminationState: input.provenance === "external" ? "external-context" : "clean",
            reviewed: input.provenance === "explicit",
          })
          await governance.appendMemoryAuditEvent({
            action: applied.some((op) => op.op === "CONFLICT" && op.memory.id === id)
              ? "conflict"
              : applied.some((op) => op.op === "UPDATE" && op.targetId === id)
                ? "revised"
                : "created",
            memoryId: id,
            sessionId: input.source?.sessionId,
            reason: input.provenance,
          })
        }
      } catch {
        // The canonical memory already landed; governance persistence retries separately.
      }
    }
    return {
      ok: true,
      stored: applied.some((op) => op.op !== "NOOP"),
      consolidated: true,
      ...(memoryId ? { memoryId } : {}),
      applied: applied.map((op) => op.op),
      ...(piiRedacted ? { piiRedacted: true } : {}),
    }
  }

  // Degraded path: no utility LLM client → direct insert (BM25-findable) +
  // best-effort vector upsert. The fact still lands; only dedupe is skipped.
  const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
  const row = await memDb.createMemory({
    scope,
    characterId,
    projectId,
    agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
    type,
    text,
    importance: candidate.importance,
    key: input.key,
    tags,
    provenance: input.provenance,
    sourceSessionId: input.source?.sessionId,
    sourceMessageId: input.source?.messageId,
    sourceChannel: input.attribution?.channel,
    sourcePluginId: input.attribution?.pluginId,
    evidenceState: "supported",
    reviewStatus: input.provenance === "explicit" ? "verified" : "unreviewed",
    contaminationState: input.provenance === "external" ? "external-context" : "clean",
    sensitivity: "normal",
  })
  try {
    const governance = await import("@/lib/db/memory-governance")
    await governance.createMemoryEvidence({
      memoryId: row.id,
      kind: input.provenance === "external" ? "external" : "manual",
      sourceId:
        input.source?.messageId ??
        input.source?.sessionId ??
        input.attribution?.pluginId ??
        input.attribution?.channel ??
        `manual:${row.id}`,
      sessionId: input.source?.sessionId,
      messageId: input.source?.messageId,
      contaminationState: input.provenance === "external" ? "external-context" : "clean",
      reviewed: input.provenance === "explicit",
    })
    await governance.appendMemoryAuditEvent({
      action: "created",
      memoryId: row.id,
      sessionId: input.source?.sessionId,
      reason: input.provenance,
    })
  } catch {
    // The canonical memory already landed; governance persistence retries separately.
  }
  const sink = await tryBuildMemoryVectorSink(config)
  if (sink) {
    try {
      await sink.upsert(row.id, row.text)
      await memDb.updateMemory(row.id, { vectorDocId: row.id })
    } catch {
      // BM25 recall still works without the vector.
    }
  }
  return {
    ok: true,
    stored: true,
    consolidated: false,
    memoryId: row.id,
    applied: ["ADD"],
    ...(piiRedacted ? { piiRedacted: true } : {}),
  }
}

export interface StoreExternalMemoryInput {
  text: string
  /** External surfaces may only create semantic/episodic (never procedural). */
  type?: Extract<MemoryType, "semantic" | "episodic">
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  key?: string
  importance?: number
  tags?: string[]
  source?: { sessionId?: string }
}

/**
 * The external-surface wrapper: provenance `external`, block-only PII gate,
 * semantic/episodic only. Used by the plugin API, MCP handler, and RPC bridge.
 */
export async function storeExternalMemory(
  input: StoreExternalMemoryInput,
  attribution: MemoryAttribution
): Promise<StoreMemoryCoreResult> {
  if ((input.type as MemoryType | undefined) === "procedural") {
    throw new Error("memory store: external surfaces may not create procedural memories.")
  }
  return storeMemoryCore({
    text: input.text,
    type: input.type ?? "semantic",
    scope: input.scope,
    characterId: input.characterId,
    projectId: input.projectId,
    agentId: input.agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
    key: input.key,
    importance: input.importance,
    tags: input.tags,
    provenance: "external",
    piiGate: "block",
    source: input.source,
    attribution,
  })
}
