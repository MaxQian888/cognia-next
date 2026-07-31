import { codexCodec } from "./codex-codec"
import type { ImportedConversation } from "@/lib/data/importers/types"

const conversation = {
  session: { id: "s-cx", createdAt: 1, updatedAt: 2 },
  messages: [{ id: "m1", sessionId: "s-cx", role: "user", parts: [{ type: "text", text: "q" }] }],
} as unknown as ImportedConversation

it("imports structured and is HONESTLY import-only (no materialize)", () => {
  expect(codexCodec.importFidelity).toBe("structured")
  expect(codexCodec.toCanonical(conversation).session.header.sourceRuntime).toBe("codex")
  expect(codexCodec.materialize).toBeUndefined()
})
