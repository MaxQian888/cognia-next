import { inboundReplyLookupIds, resolveInboundReplyTo } from "./inbound-reply-to"

it("ignores malformed reply identifiers and snippets at the common boundary", async () => {
  const event = {
    platform: "matrix",
    conversationRef: { roomId: "!r:s" },
    replyTo: { messageId: 42, snippet: {} },
  } as never
  expect(inboundReplyLookupIds(event)).toEqual([])
  expect(await resolveInboundReplyTo({ event, findParent: async () => undefined })).toBeUndefined()
  expect(
    await resolveInboundReplyTo({
      event: { replyTo: { messageId: "$valid", snippet: {} as never } },
      findParent: async () => undefined,
    })
  ).toMatchObject({ preview: "" })
})

it("matches Matrix and QQ wire references to public delivery ids", () => {
  expect(
    inboundReplyLookupIds({
      platform: "matrix",
      conversationRef: { platform: "matrix", adapterId: "a", roomId: "!room:srv" },
      replyTo: { messageId: "$parent", snippet: "" },
    })
  ).toEqual(["$parent", "!room:srv|$parent"])
  expect(
    inboundReplyLookupIds({
      platform: "qq-official",
      conversationRef: {
        platform: "qq-official",
        adapterId: "a",
        scene: "channel",
        sceneId: "channel",
      },
      replyTo: { messageId: "parent", snippet: "" },
    })
  ).toEqual(["parent", "channel:channel:parent"])
})

it("scrubs inline bytes from both parent and descriptor previews before clipping", async () => {
  const event = {
    replyTo: {
      messageId: "remote-parent",
      snippet: "before [image: data:image/png;base64,DISPLAY] after",
    },
  }
  const missing = await resolveInboundReplyTo({ event, findParent: async () => undefined })
  expect(missing?.preview).toBe("before [image] after")
  const found = await resolveInboundReplyTo({
    event,
    findParent: async () => ({
      id: "local-parent",
      parts: [{ type: "text", text: `[image: data:image/png;base64,${"DISPLAY".repeat(100)}]` }],
    }),
  })
  expect(found?.preview).toBe("[image]")
})

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
