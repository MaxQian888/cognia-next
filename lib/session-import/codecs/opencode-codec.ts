// OpenCode session codec (ADR-0090 Phase 8).
//
// Import: OpenCode storage parses into text+tool parts (`structured`). No
// `materialize` — no public seed-from-external path; honestly import-only.

import type { ImportedConversation } from "@/lib/data/importers/types"
import { conversationToCanonical, type SessionCodec } from "@/lib/session-import/codec-types"

export const opencodeCodec: SessionCodec = {
  importFidelity: "structured",
  toCanonical(conversation: ImportedConversation) {
    return conversationToCanonical(conversation, {
      sourceRuntime: "opencode",
      importFidelity: "structured",
    })
  },
}
