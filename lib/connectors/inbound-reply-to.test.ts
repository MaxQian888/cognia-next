import { resolveInboundReplyTo } from "./inbound-reply-to"

it("returns nothing for a message that is not a reply", async () => {
  expect(
    await resolveInboundReplyTo({ event: {}, findParent: async () => undefined })
  ).toBeUndefined()
  expect(
    await resolveInboundReplyTo({
      event: { replyTo: { messageId: "", snippet: "x" } },
      findParent: async () => undefined,
    })
  ).toBeUndefined()
})

it("resolves to the stored parent and prefers its text over the platform snippet", async () => {
  const result = await resolveInboundReplyTo({
    event: { replyTo: { messageId: "42", snippet: "should we…" } },
    findParent: async (id) =>
      id === "42"
        ? { id: "m-parent", parts: [{ type: "text", text: "should we ship?" }] }
        : undefined,
  })
  expect(result).toEqual({
    messageId: "m-parent",
    preview: "should we ship?",
    platformMessageId: "42",
  })
})

it("keeps the platform id and snippet when the parent was never stored", async () => {
  const result = await resolveInboundReplyTo({
    event: { replyTo: { messageId: "42", snippet: "  old   message " } },
    findParent: async () => undefined,
  })
  expect(result).toEqual({ messageId: "42", preview: "old message", platformMessageId: "42" })
})

it("falls back to the snippet when the stored parent has no text", async () => {
  const result = await resolveInboundReplyTo({
    event: { replyTo: { messageId: "42", snippet: "[photo]" } },
    findParent: async () => ({ id: "m-parent", parts: [] }),
  })
  expect(result?.preview).toBe("[photo]")
})
