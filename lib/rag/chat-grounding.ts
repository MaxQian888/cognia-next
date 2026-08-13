import type { UIMessage } from "ai"
import { groundAnswer, type GroundingResult, type RetrievalHit } from "@cognia/rag"

import type { SendOptions } from "@cognia/agent-config-types"

import type { GroundingPart, SourcesPart, SourcesPartItem } from "@/lib/claude/parts-extensions"

const EVIDENCE_ORIGINS = new Set<SourcesPartItem["origin"]>([
  "twin-rag",
  "agent-knowledge-base",
  "project-knowledge",
  "memory",
  "anthropic",
  "footnote",
])

function sourceHit(source: SourcesPartItem): RetrievalHit | undefined {
  const content = source.snippet?.trim()
  if (!content || !EVIDENCE_ORIGINS.has(source.origin)) return undefined
  return {
    id: source.id,
    sourceId: source.id,
    domain:
      source.origin === "memory"
        ? "memory"
        : source.origin === "twin-rag"
          ? "twin"
          : source.origin === "project-knowledge"
            ? "project"
            : source.origin === "agent-knowledge-base"
              ? "kb"
              : "external",
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    trust: source.origin === "anthropic" || source.origin === "footnote" ? "untrusted" : "trusted",
    citation: { sourceRevision: "persisted-source-v1", startOffset: 0, endOffset: content.length },
    score: source.score ?? 0,
  }
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        (part as { type?: string }).type === "text"
    )
    .map((part) => part.text)
    .join("")
}

function sourcesOf(message: UIMessage): SourcesPart | undefined {
  return message.parts.find((part) => (part as { type?: string }).type === "sources") as unknown as
    SourcesPart | undefined
}

function toPart(result: GroundingResult): GroundingPart {
  const support = new Map(result.support.map((item) => [item.claimId, item]))
  return {
    type: "grounding",
    supportRatio: result.supportRatio,
    action: result.action === "annotate" ? "annotate" : "allow",
    claims: result.claims.map((claim) => ({
      ...claim,
      supported: support.get(claim.id)?.supported ?? false,
      hitIds: support.get(claim.id)?.hitIds ?? [],
    })),
  }
}

function optionHits(options: SendOptions): RetrievalHit[] {
  const sources: SourcesPartItem[] = [
    ...(options.twinContext?.retrievedChunks.map(({ chunk, score }) => ({
      id: `twin-${chunk.id}`,
      title: chunk.sourceId,
      snippet: chunk.contentRedacted,
      origin: "twin-rag" as const,
      score,
    })) ?? []),
    ...(options.memoryContext?.retrievedMemories.map((memory) => ({
      id: `memory-${memory.id}`,
      title: memory.id,
      snippet: memory.text,
      origin: "memory" as const,
      score: memory.score,
    })) ?? []),
    ...(options.projectKnowledgeContext?.retrievedChunks.map((chunk) => ({
      id: `project-${chunk.fileId}`,
      title: chunk.fileName ?? chunk.fileId,
      snippet: chunk.content,
      origin: "project-knowledge" as const,
      score: chunk.score,
    })) ?? []),
    ...(options.agentKnowledgeContext?.retrievedChunks.map(({ chunk, score }) => ({
      id: `kb-${chunk.id}`,
      title: chunk.sourceId,
      snippet: chunk.content,
      origin: "agent-knowledge-base" as const,
      score,
    })) ?? []),
  ]
  return sources.map(sourceHit).filter((hit): hit is RetrievalHit => Boolean(hit))
}

/** Ground an automated/external answer against the exact retrieval context sent to its model. */
export function groundSendOptionsAnswer(
  answer: string,
  options: SendOptions | undefined,
  path: "automation" | "external_send" | "high_risk"
): GroundingResult | undefined {
  if (!options) return undefined
  const hits = optionHits(options)
  if (hits.length === 0) return undefined
  return groundAnswer(answer, hits, { path })
}

/** Post-stream interactive grounding: annotate only when this turn actually used retrieval. */
export function attachInteractiveGrounding(
  messages: UIMessage[],
  options: SendOptions | undefined
): UIMessage[] {
  if (
    !options?.twinContext &&
    !options?.memoryContext &&
    !options?.projectKnowledgeContext &&
    !options?.agentKnowledgeContext
  ) {
    return messages
  }
  const index = messages.findLastIndex((message) => message.role === "assistant")
  if (index < 0) return messages
  const message = messages[index]
  if (message.parts.some((part) => (part as { type?: string }).type === "grounding"))
    return messages
  const sources = sourcesOf(message)
  const hits =
    sources?.sources.map(sourceHit).filter((hit): hit is RetrievalHit => Boolean(hit)) ?? []
  const answer = textOf(message).trim()
  if (!answer || hits.length === 0) return messages

  const result = groundAnswer(answer, hits, { path: "interactive_chat" })
  const next = messages.slice()
  next[index] = {
    ...message,
    parts: [...message.parts, toPart(result) as unknown as UIMessage["parts"][number]],
  }
  return next
}
