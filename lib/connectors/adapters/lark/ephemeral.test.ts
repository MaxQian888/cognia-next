import { createLarkEphemeral } from "./ephemeral"
import type { OutboundRequest, OutboundError } from "@/types/connectors/outbound"

const req = (): OutboundRequest => ({
  conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "oc_group" },
  segments: [
    { type: "card", card: { kind: "lark", payload: { schema: "2.0", body: { elements: [] } } } },
  ],
  metadata: { idempotencyKey: "local-key", larkEphemeral: { recipientOpenId: "ou_person" } },
})
const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "Private form" }] } }
const classifyError = (error: unknown): OutboundError => error as OutboundError
const network = { code: "network", message: "lost response", retryable: true }
function setup(sendAsUser = false) {
  const request = jest.fn(
    async (_method: string, path: string, _body?: unknown): Promise<unknown> =>
      path.startsWith("/im/v1/chats/")
        ? { code: 0, data: { chat_mode: "group", chat_type: "private" } }
        : { code: 0, data: { message_id: "om_private" } }
  )
  return { request, helper: createLarkEphemeral({ request, classifyError, sendAsUser }) }
}

describe("Lark ephemeral cards", () => {
  it("checks ordinary group membership before preparing and posting the card object", async () => {
    const { request, helper } = setup()
    const prepare = jest.fn(async () => {
      expect(request).toHaveBeenCalledTimes(1)
      return card
    })
    expect(await helper.send(req(), prepare)).toEqual({ ok: true, platformMessageId: "om_private" })
    expect(request.mock.calls).toEqual([
      ["GET", "/im/v1/chats/oc_group"],
      [
        "POST",
        "/ephemeral/v1/send",
        { chat_id: "oc_group", open_id: "ou_person", msg_type: "interactive", card },
      ],
    ])
    expect(JSON.stringify(request.mock.calls[1])).not.toContain("uuid")
  })

  it.each([
    { editTargetMessageId: "om_public" },
    { threadId: "omt_topic" },
    { replyTo: { messageId: "om_parent" } },
    { conversationRef: { ...req().conversationRef, threadTs: "omt_legacy" } },
    { conversationRef: { ...req().conversationRef, threadId: "omt_topic" } },
    { conversationRef: { ...req().conversationRef, platform: "telegram" } },
    { segments: [{ type: "text", text: "not a card" }] },
    { metadata: { ...req().metadata, larkEphemeral: { recipientOpenId: "" } } },
  ])("rejects unsupported request before any I/O: %j", async (patch) => {
    const { request, helper } = setup()
    const prepare = jest.fn(async () => card)
    const result = await helper.send({ ...req(), ...patch } as OutboundRequest, prepare)
    expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
    expect(request).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it("rejects send-as-user before preparing or sending", async () => {
    const { request, helper } = setup(true)
    expect(await helper.send(req(), async () => card)).toMatchObject({
      ok: false,
      error: { code: "validation" },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([{ chat_mode: "topic", chat_type: "private" }, { chat_mode: "p2p" }, {}])(
    "fails closed on non-group or unknown chat info: %j",
    async (data) => {
      const { request, helper } = setup()
      request.mockResolvedValueOnce({ data })
      const prepare = jest.fn(async () => card)
      expect(await helper.send(req(), prepare)).toMatchObject({
        ok: false,
        error: { code: "validation" },
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(prepare).not.toHaveBeenCalled()
    }
  )

  it("keeps preflight failures retryable and never enters the send endpoint", async () => {
    const { request, helper } = setup()
    request.mockRejectedValueOnce(network)
    expect(await helper.send(req(), async () => card)).toEqual({
      ok: false,
      error: { ...network, code: "preparation_failed" },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("keeps local preparation failures outside the ambiguous send boundary", async () => {
    const { request, helper } = setup()
    expect(
      await helper.send(req(), async () => {
        throw network
      })
    ).toEqual({ ok: false, error: { ...network, code: "preparation_failed" } })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([network, { code: "platform_5xx", message: "gateway error", retryable: true }])(
    "does not retry potentially delivered posts: %j",
    async (error) => {
      const { request, helper } = setup()
      request.mockImplementation(async (_method, path) => {
        if (path.endsWith("/send")) throw error
        return { data: { chat_mode: "group", chat_type: "private" } }
      })
      expect(await helper.send(req(), async () => card)).toMatchObject({
        ok: false,
        error: { code: "delivery_unknown", retryable: false },
      })
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it("allows explicit platform rate-limit retry and detects an ambiguous missing message id", async () => {
    const { request, helper } = setup()
    const limited = {
      code: "rate_limited",
      message: "slow down",
      retryable: true,
      retryAfterMs: 3000,
    }
    request.mockImplementation(async (_method, path) => {
      if (path.endsWith("/send")) throw limited
      return { data: { chat_mode: "group", chat_type: "private" } }
    })
    expect(await helper.send(req(), async () => card)).toEqual({ ok: false, error: limited })
    request.mockResolvedValue({ data: { chat_mode: "group", chat_type: "private" } })
    expect(await helper.send(req(), async () => card)).toMatchObject({
      ok: false,
      error: { code: "delivery_unknown", retryable: false },
    })
  })

  it("rejects malformed prepared cards without public-message fallback", async () => {
    const { request, helper } = setup()
    expect(await helper.send(req(), async () => JSON.stringify(card))).toMatchObject({
      ok: false,
      error: { code: "validation" },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("deletes through the dedicated endpoint and validates message identity", async () => {
    const { request, helper } = setup()
    await helper.delete("om_private")
    expect(request).toHaveBeenCalledWith("POST", "/ephemeral/v1/delete", {
      message_id: "om_private",
    })
    await expect(helper.delete("")).rejects.toThrow("message_id")
    expect(request).toHaveBeenCalledTimes(1)
  })
})
