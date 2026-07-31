import { claudeCodeCodec } from "./claude-code-codec"
import type { ImportedConversation } from "@/lib/data/importers/types"

const conversation = {
  session: { id: "s-cc", title: "T", createdAt: 1, updatedAt: 2 },
  messages: [{ id: "m1", sessionId: "s-cc", role: "user", parts: [{ type: "text", text: "q" }] }],
} as unknown as ImportedConversation

it("imports structured and materializes CONTEXTUAL only (R1 spike verdict)", () => {
  expect(claudeCodeCodec.importFidelity).toBe("structured")
  const { session, loss } = claudeCodeCodec.toCanonical(conversation)
  expect(session.header.sourceRuntime).toBe("claude-code")
  expect(loss.fidelity).toBe("structured")
  // Pinned to the R1 spike: no native-exact materialization exists.
  expect(claudeCodeCodec.materialize?.fidelity).toBe("contextual")
  expect(claudeCodeCodec.materialize?.buildReplayPrompt(session)).toContain("user: q")
})
