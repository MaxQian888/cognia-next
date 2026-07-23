import { opencodeCodec } from "./opencode-codec"
import type { ImportedConversation } from "@/lib/data/importers/types"

const conversation = {
  session: { id: "s-oc", createdAt: 1, updatedAt: 2 },
  messages: [{ id: "m1", sessionId: "s-oc", role: "user", parts: [{ type: "text", text: "q" }] }],
} as unknown as ImportedConversation

it("imports structured and is HONESTLY import-only (no materialize)", () => {
  expect(opencodeCodec.importFidelity).toBe("structured")
  expect(opencodeCodec.toCanonical(conversation).session.header.sourceRuntime).toBe("opencode")
  expect(opencodeCodec.materialize).toBeUndefined()
})
