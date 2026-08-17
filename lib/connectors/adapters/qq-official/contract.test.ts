// Adapter contract suite for QQ Official Bot — mirrors
// `telegram/contract.test.ts`. One `describe` per declared Capability: build
// adapter → mock the Tauri HTTP wrapper → call the adapter method → assert the
// QQ REST request shape (URL + body). Plus one "intentionally absent" case per
// mutation method the adapter does NOT declare.

import { invoke } from "@tauri-apps/api/core"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createQQOfficialAdapter } from "./index"
import { __resetQQMsgSeqForTesting, qqPassiveMsgSeq } from "./serialize"
import { startQQGateway } from "./gateway-client"

jest.mock("./gateway-client", () => ({ startQQGateway: jest.fn() }))
jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))

const mockInvoke = invoke as jest.Mock
const mockStartGateway = startQQGateway as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function makeAdapter() {
  return createQQOfficialAdapter({
    id: "qq-contract",
    displayName: "Contract QQ",
    accessToken: async () => "TOKEN",
  })
}

function req(
  scene: "group" | "c2c" | "channel" | "direct",
  sceneId: string,
  msgId: string | undefined,
  segments: OutboundRequest["segments"],
  extra: Partial<OutboundRequest> = {}
): OutboundRequest {
  return {
    conversationRef: { platform: "qq-official", adapterId: "qq-contract", scene, sceneId, msgId },
    segments,
    metadata: { idempotencyKey: "k-contract" },
    ...extra,
  }
}

function httpCalls(): Array<{ url: string; method: string; body: Record<string, unknown> }> {
  return mockInvoke.mock.calls
    .filter(([cmd]: [string]) => cmd === "connectors_http_request")
    .map((c) => {
      const r = (c[1] as { req: { url: string; method: string; body?: string } }).req
      return { url: r.url, method: r.method, body: r.body ? JSON.parse(r.body) : {} }
    })
}

function lastHttpCall() {
  const calls = httpCalls()
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]
}

/** Start on a fake gateway that yields one dispatch then hangs. */
async function startWithDispatch(adapter: ReturnType<typeof makeAdapter>, dispatch: unknown) {
  let delivered = false
  mockStartGateway.mockReturnValue({
    selfId: "bot",
    dispatches: {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () => {
        if (!delivered) {
          delivered = true
          return Promise.resolve({ done: false, value: dispatch })
        }
        return new Promise(() => {})
      },
    },
  })
  await adapter.start({ emit: jest.fn() } as unknown as AdapterContext)
  await new Promise((r) => setTimeout(r, 0))
}

describe("QQ Official adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockStartGateway.mockReset()
    __resetQQMsgSeqForTesting()
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-1" }))
  })

  describe("send.text capability", () => {
    it("group text becomes POST /v2/groups/{openid}/messages msg_type 0 and returns a scene-qualified id", async () => {
      const res = await makeAdapter().send(
        req("group", "GO", undefined, [{ type: "text", text: "hi" }])
      )
      expect(res.ok).toBe(true)
      expect(res.platformMessageId).toBe("group:GO:sent-1")
      const call = lastHttpCall()
      expect(call.method).toBe("POST")
      expect(call.url).toBe("https://api.sgroup.qq.com/v2/groups/GO/messages")
      expect(call.body).toEqual({ content: "hi", msg_type: 0 })
    })

    it("addresses c2c / channel / direct on their scene endpoints", async () => {
      const adapter = makeAdapter()
      await adapter.send(req("c2c", "UO", undefined, [{ type: "text", text: "a" }]))
      await adapter.send(req("channel", "CH", undefined, [{ type: "text", text: "b" }]))
      await adapter.send(req("direct", "G", undefined, [{ type: "text", text: "c" }]))
      expect(httpCalls().map((c) => c.url.replace("https://api.sgroup.qq.com", ""))).toEqual([
        "/v2/users/UO/messages",
        "/channels/CH/messages",
        "/dms/G/messages",
      ])
    })
  })

  describe("send.reply capability", () => {
    it("OutboundRequest.replyTo becomes the passive msg_id with an idempotency-derived msg_seq", async () => {
      await makeAdapter().send(
        req("group", "GO", "captured", [{ type: "text", text: "re" }], {
          replyTo: { messageId: "explicit" },
        })
      )
      const call = lastHttpCall()
      expect(call.body).toEqual({
        content: "re",
        msg_type: 0,
        msg_id: "explicit",
        msg_seq: qqPassiveMsgSeq("k-contract"),
      })
    })

    it("guild scenes take msg_id only (no msg_seq)", async () => {
      await makeAdapter().send(req("channel", "CH", "m3", [{ type: "text", text: "re" }]))
      const call = lastHttpCall()
      expect(call.body).toEqual({ content: "re", msg_id: "m3" })
    })
  })

  describe("delete capability", () => {
    it("delete() DELETEs on the scene endpoint decoded from the composite id", async () => {
      mockInvoke.mockResolvedValue(httpResp(200, ""))
      const adapter = makeAdapter()
      await adapter.delete!("group:GO:m1")
      await adapter.delete!("channel:CH:m2")
      expect(
        httpCalls().map((c) => [c.method, c.url.replace("https://api.sgroup.qq.com", "")])
      ).toEqual([
        ["DELETE", "/v2/groups/GO/messages/m1"],
        ["DELETE", "/channels/CH/messages/m2?hidetip=false"],
      ])
    })

    it("delete() rejects a bare id instead of guessing the scene", async () => {
      await expect(makeAdapter().delete!("m1")).rejects.toThrow(/scene:sceneId:id/)
      expect(httpCalls()).toHaveLength(0)
    })
  })

  describe("send.reaction capability (channel scene only)", () => {
    it("addReaction PUTs /channels/{c}/messages/{m}/reactions/{type}/{id}; removeReaction DELETEs it", async () => {
      mockInvoke.mockResolvedValue(httpResp(204, ""))
      const adapter = makeAdapter()
      const ref = await adapter.addReaction!("channel:CH:m9", "1:4")
      expect(ref).toEqual({ reactionId: "1:4" })
      await adapter.removeReaction!("channel:CH:m9", "1:4")
      expect(
        httpCalls().map((c) => [c.method, c.url.replace("https://api.sgroup.qq.com", "")])
      ).toEqual([
        ["PUT", "/channels/CH/messages/m9/reactions/1/4"],
        ["DELETE", "/channels/CH/messages/m9/reactions/1/4"],
      ])
    })

    it("throws unsupported outside the channel scene", async () => {
      await expect(makeAdapter().addReaction!("group:GO:m1", "1:4")).rejects.toThrow(/unsupported/)
      expect(httpCalls()).toHaveLength(0)
    })
  })

  describe("typing capability (c2c scene only)", () => {
    it("setTyping(on) sends a msg_type 6 input_notify passive reply to the cached c2c msg_id", async () => {
      const adapter = makeAdapter()
      await startWithDispatch(adapter, {
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: { id: "in-1", content: "hi", author: { user_openid: "UO" } },
      })
      mockInvoke.mockResolvedValue(httpResp(200, {}))
      await adapter.setTyping!("qq-official:qq-contract:UO", true)
      const call = lastHttpCall()
      expect(call.url).toBe("https://api.sgroup.qq.com/v2/users/UO/messages")
      expect(call.body).toMatchObject({
        msg_type: 6,
        input_notify: { input_type: 1, input_second: 60 },
        msg_id: "in-1",
      })
      await adapter.stop()
    })

    it("setTyping is a silent no-op for on=false and for non-c2c scenes", async () => {
      const adapter = makeAdapter()
      await startWithDispatch(adapter, {
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: { id: "g-1", content: "hi", group_openid: "GO" },
      })
      await adapter.setTyping!("qq-official:qq-contract:GO", true)
      await adapter.setTyping!("qq-official:qq-contract:UO", false)
      expect(httpCalls()).toHaveLength(0)
      await adapter.stop()
    })
  })

  describe("edit / history.fetch (intentionally absent)", () => {
    it("declares neither and implements no method for them (QQ bot API has no edit / history read)", () => {
      const adapter = makeAdapter()
      expect(adapter.meta.capabilities).not.toContain("edit")
      expect(adapter.meta.capabilities).not.toContain("history.fetch")
      expect(adapter.edit).toBeUndefined()
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.fetchHistoryPage).toBeUndefined()
      expect(adapter.streamReply).toBeUndefined()
    })
  })
})
