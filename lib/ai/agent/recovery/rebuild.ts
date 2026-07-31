// Canonical rebuild (ADR-0090 Phase 8).
//
// When the canonical log is missing or damaged, a session record may be
// RECONSTRUCTED from trusted runtime artifacts (persisted messages, tool
// journals). The result is provenance-marked `rebuilt: true` and every gap
// is an explicit loss entry — a rebuilt record never pretends to be the
// original.

import {
  computeSequenceDigest,
  type CanonicalSession,
  type CanonicalTurn,
  type SessionFidelity,
  type SessionLossEntry,
  type SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"

export type TrustedEvidence = { kind: "turn"; turn: CanonicalTurn } | { kind: "gap"; note: string }

export interface RebuildInput {
  canonicalSessionId: string
  sourceRuntime: string
  fidelity: SessionFidelity
  evidence: TrustedEvidence[]
  title?: string
  nativeSessionId?: string
}

export function rebuildCanonicalSession(input: RebuildInput): {
  session: CanonicalSession
  loss: SessionLossReport
} {
  const turns: CanonicalTurn[] = []
  const losses: SessionLossEntry[] = []
  for (const [index, item] of input.evidence.entries()) {
    if (item.kind === "turn") {
      turns.push(item.turn)
    } else {
      losses.push({ path: `evidence[${index}]`, kind: "dropped", detail: item.note })
    }
  }
  const now = new Date().toISOString()
  const session: CanonicalSession = {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: input.canonicalSessionId,
      sourceRuntime: input.sourceRuntime,
      ...(input.nativeSessionId
        ? { runtimeBinding: { nativeSessionId: input.nativeSessionId } }
        : {}),
      ...(input.title ? { title: input.title } : {}),
      createdAt: now,
      updatedAt: now,
      turnCount: turns.length,
      importFidelity: input.fidelity,
      sequenceDigest: computeSequenceDigest(turns),
    },
    turns,
  }
  return { session, loss: { fidelity: input.fidelity, losses, rebuilt: true } }
}
