import type { Character } from "@cognia/agent-config-types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalTarget } from "../runner"
import { createChatTarget, type ChatTargetDeps } from "./chat"

export interface TwinTargetConfig {
  label: string
  twinId: string
  providerId?: string
  model: string
  timeoutMs?: number
}

export interface TwinEvalChunkProjection {
  id: string
  contentRedacted: string
}

/** Hydrate safe chunk text in memory for Eval scoring; persisted spans remain ID-only. */
export async function hydrateTwinRetrievalSpans(
  spans: AgentTraceSpan[],
  twinId: string,
  loadChunks?: (ids: string[]) => Promise<TwinEvalChunkProjection[]>
): Promise<AgentTraceSpan[]> {
  const ids = [
    ...new Set(
      spans
        .filter((span) => span.providerName === "cognia.twin" && span.metadata?.twinId === twinId)
        .flatMap((span) =>
          Array.isArray(span.metadata?.chunkIds)
            ? span.metadata.chunkIds.filter((id): id is string => typeof id === "string")
            : []
        )
    ),
  ]
  if (ids.length === 0) return spans
  const loader =
    loadChunks ??
    (async (chunkIds: string[]) => {
      const { getTwinChunksByIds } = await import("@/lib/db/twin-chunks")
      return getTwinChunksByIds(chunkIds)
    })
  const chunks = await loader(ids)
  const textById = new Map(chunks.map((chunk) => [chunk.id, chunk.contentRedacted]))

  return spans.map((span) => {
    if (span.providerName !== "cognia.twin" || span.metadata?.twinId !== twinId) return span
    const chunkIds = Array.isArray(span.metadata.chunkIds)
      ? span.metadata.chunkIds.filter((id): id is string => typeof id === "string")
      : []
    const scores = Array.isArray(span.metadata.chunkScores) ? span.metadata.chunkScores : []
    return {
      ...span,
      metadata: {
        ...span.metadata,
        retrievedChunks: chunkIds.flatMap((id, index) => {
          const text = textById.get(id)
          return text === undefined
            ? []
            : [{ id, text, ...(typeof scores[index] === "number" ? { score: scores[index] } : {}) }]
        }),
      },
    }
  })
}

/** Reuse the Chat target with an ephemeral, Twin-bound Character. */
export function createTwinTarget(config: TwinTargetConfig, deps: ChatTargetDeps): EvalTarget {
  const now = Date.now()
  const character: Character = {
    id: `__eval-twin:${config.twinId}`,
    name: `Twin ${config.twinId}`,
    avatarColor: "oklch(0.6 0 0)",
    systemPrompt: "Answer as the selected Digital Twin.",
    twinId: config.twinId,
    model: config.model,
    createdAt: now,
    updatedAt: now,
  }
  const twinDeps: ChatTargetDeps = {
    ...deps,
    async runTurn(input) {
      if (!hasNoLeakingPiiDeep(input.prompt)) {
        throw new Error("Twin Eval input contains unredacted PII")
      }
      return deps.runTurn(input)
    },
    async fetchSpans(sessionId: string) {
      return hydrateTwinRetrievalSpans(await deps.fetchSpans(sessionId), config.twinId)
    },
  }
  return createChatTarget(
    {
      label: config.label,
      model: config.model,
      character,
      ...(config.providerId ? { providerId: config.providerId } : {}),
      ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    },
    twinDeps
  )
}
