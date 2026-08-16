// Pi session codec (ADR-0119, ADR-0090 Phase 8).
//
// Import: Pi's JSONL carries text, thinking and fully-resolved tool calls, so
// `toCanonical` is `structured` — the same tier as Claude Code, and for the
// same reason (nothing model-visible is reconstructed or guessed).
//
// Materialize: Pi's RPC surface has `new_session`, `switch_session` and
// `fork`, but no create-from-external-messages call, and a private session
// file is never forged. The reverse direction is therefore `contextual`: a
// replay prompt seeds a NEW native Pi session whose own id becomes the runtime
// binding.

import type { ImportedConversation } from "@/lib/data/importers/types"
import {
  buildReplayPrompt,
  conversationToCanonical,
  type SessionCodec,
} from "@/lib/session-import/codec-types"

export const piCodec: SessionCodec = {
  importFidelity: "structured",
  toCanonical(conversation: ImportedConversation) {
    return conversationToCanonical(conversation, {
      sourceRuntime: "pi",
      importFidelity: "structured",
    })
  },
  materialize: {
    fidelity: "contextual",
    buildReplayPrompt,
  },
}
