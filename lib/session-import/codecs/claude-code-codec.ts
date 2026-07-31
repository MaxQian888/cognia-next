// Claude Code session codec (ADR-0090 Phase 8).
//
// Import: the JSONL transcripts parse into full text+tool parts, so
// `toCanonical` is `structured`. Materialize: per the R1 spike verdict
// (sidecar/dispatch/session-materialize.spike.live.test.mjs) there is NO
// public create-from-external-messages API and private JSONL is never
// forged, so the reverse direction is `contextual` — a replay prompt that
// seeds a NEW native session (whose own id then becomes the runtime
// binding).

import type { ImportedConversation } from "@/lib/data/importers/types"
import {
  buildReplayPrompt,
  conversationToCanonical,
  type SessionCodec,
} from "@/lib/session-import/codec-types"

export const claudeCodeCodec: SessionCodec = {
  importFidelity: "structured",
  toCanonical(conversation: ImportedConversation) {
    return conversationToCanonical(conversation, {
      sourceRuntime: "claude-code",
      importFidelity: "structured",
    })
  },
  materialize: {
    fidelity: "contextual",
    buildReplayPrompt,
  },
}
