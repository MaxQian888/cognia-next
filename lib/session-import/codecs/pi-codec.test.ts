import { piCodec } from "./pi-codec"
import type { ImportedConversation } from "@/lib/data/importers/types"

const conversation = {
  session: { id: "s-pi", title: "T", createdAt: 1, updatedAt: 2 },
  messages: [{ id: "m1", sessionId: "s-pi", role: "user", parts: [{ type: "text", text: "q" }] }],
} as unknown as ImportedConversation

it("imports structured and materializes CONTEXTUAL only", () => {
  expect(piCodec.importFidelity).toBe("structured")
  const { session, loss } = piCodec.toCanonical(conversation)
  expect(session.header.sourceRuntime).toBe("pi")
  expect(loss.fidelity).toBe("structured")
  // Pi's RPC surface has new_session/switch_session/fork but no
  // create-from-external-messages call, and a private session file is never
  // forged — so the reverse direction can only be a replay prompt.
  expect(piCodec.materialize?.fidelity).toBe("contextual")
  expect(piCodec.materialize?.buildReplayPrompt(session)).toContain("user: q")
})

it("reports reasoning parts as a loss, since canonical has no slot for them", () => {
  const withThinking = {
    session: { id: "s-pi", title: "T", createdAt: 1, updatedAt: 2 },
    messages: [
      {
        id: "m1",
        sessionId: "s-pi",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "hmm" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  } as unknown as ImportedConversation

  const { loss } = piCodec.toCanonical(withThinking)
  // Pi streams thinking as first-class content, so an import that silently
  // dropped it would understate what the transcript actually contained.
  expect(loss.losses.length).toBeGreaterThan(0)
  expect(loss.losses).toContainEqual(
    expect.objectContaining({ path: expect.stringContaining("reasoning"), kind: "dropped" })
  )
})
