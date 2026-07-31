// Codex session codec (ADR-0090 Phase 8).
//
// Import: Codex rollout files parse into text+tool parts (`structured`).
// No `materialize`: Codex has no public path to seed one of its sessions
// from external content — this codec is honestly import-only, and callers
// see the absence instead of a pretend implementation.

import type { ImportedConversation } from "@/lib/data/importers/types"
import { conversationToCanonical, type SessionCodec } from "@/lib/session-import/codec-types"

export const codexCodec: SessionCodec = {
  importFidelity: "structured",
  toCanonical(conversation: ImportedConversation) {
    return conversationToCanonical(conversation, {
      sourceRuntime: "codex",
      importFidelity: "structured",
    })
  },
}
