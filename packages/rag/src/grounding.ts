import type { RetrievalHit, RetrievalTraceV1 } from "./retrieval-kernel"
import { tokenizeMultilingual } from "./cjk-tokenizer"

export type GroundingPath = "interactive_chat" | "automation" | "external_send" | "high_risk"

export interface GroundingClaim {
  id: string
  text: string
  startOffset: number
  endOffset: number
}

export interface ClaimSupport {
  claimId: string
  hitIds: string[]
  score: number
  supported: boolean
}

export interface GroundingResult {
  claims: GroundingClaim[]
  support: ClaimSupport[]
  unsupportedClaimIds: string[]
  supportRatio: number
  blocked: boolean
  action: "allow" | "annotate" | "retry" | "block"
}

export interface GroundingOptions {
  path: GroundingPath
  claimThreshold?: number
  answerThreshold?: number
}

function extractClaims(answer: string): GroundingClaim[] {
  const claims: GroundingClaim[] = []
  const expression = /[^.!?。！？\n]+[.!?。！？]?/g
  for (const match of answer.matchAll(expression)) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (!text) continue
    const startOffset = (match.index ?? 0) + leading
    claims.push({
      id: `claim-${claims.length + 1}`,
      text,
      startOffset,
      endOffset: startOffset + text.length,
    })
  }
  return claims
}

function supportScore(claim: string, evidence: string): number {
  const claimTokens = new Set(tokenizeMultilingual(claim))
  const evidenceTokens = new Set(tokenizeMultilingual(evidence))
  if (claimTokens.size === 0 || evidenceTokens.size === 0) return 0
  let overlap = 0
  for (const token of claimTokens) if (evidenceTokens.has(token)) overlap += 1
  return overlap / claimTokens.size
}

export function groundAnswer(
  answer: string,
  hits: readonly RetrievalHit[],
  options: GroundingOptions
): GroundingResult {
  const claims = extractClaims(answer)
  const claimThreshold = options.claimThreshold ?? 0.6
  const answerThreshold = options.answerThreshold ?? 0.8
  const support = claims.map((claim) => {
    const ranked = hits
      .map((hit) => ({ id: hit.id, score: supportScore(claim.text, hit.content) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    const score = ranked[0]?.score ?? 0
    return {
      claimId: claim.id,
      hitIds: ranked.filter((item) => item.score >= claimThreshold).map((item) => item.id),
      score,
      supported: score >= claimThreshold,
    }
  })
  const unsupportedClaimIds = support.filter((item) => !item.supported).map((item) => item.claimId)
  const supportRatio =
    claims.length === 0 ? 1 : (claims.length - unsupportedClaimIds.length) / claims.length
  const automaticPath = options.path !== "interactive_chat"
  const blocked = automaticPath && supportRatio < answerThreshold
  return {
    claims,
    support,
    unsupportedClaimIds,
    supportRatio,
    blocked,
    action: blocked
      ? options.path === "automation"
        ? "retry"
        : "block"
      : unsupportedClaimIds.length > 0
        ? "annotate"
        : "allow",
  }
}

export function attachGroundingToTrace(
  trace: RetrievalTraceV1,
  grounding: GroundingResult
): RetrievalTraceV1 {
  return {
    ...trace,
    grounding: {
      supportedClaims: grounding.claims.length - grounding.unsupportedClaimIds.length,
      unsupportedClaims: grounding.unsupportedClaimIds.length,
      blocked: grounding.blocked,
    },
  }
}
