// Adapter contract suite for DingTalk (钉钉) — mirrors
// `telegram/contract.test.ts`. One `describe` per declared Capability: build
// adapter → mock the Tauri HTTP wrapper → call the adapter method → assert the
// OpenAPI request shape (URL + body). Plus one "intentionally absent" case per
// mutation method the adapter does NOT declare.

const mockHttp = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...a: unknown[]) => mockHttp(...a),
}))
jest.mock("./stream-client", () => ({
  TOPIC_BOT_MESSAGE: "/v1.0/im/bot/messages/get",
  startDingTalkStream: () => ({ frames: (async function* () {})() }),
}))
jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))

import { createDingTalkAdapter } from "./index"
import type { OutboundRequest } from "@/types/connectors/outbound"

function makeAdapter() {
  return createDingTalkAdapter({
    id: "dt-contract",
    displayName: "Contract DingTalk",
    appKey: async () => "ak",
    appSecret: async () => "as",
    accessToken: async () => "TOKEN",
    selfId: "self_bot",
  })
}

function okResp(body: unknown = { processQueryKey: "pqk_1" }) {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

function ref(over: Record<string, unknown> = {}) {
  return { platform: "dingtalk", adapterId: "dt-contract", robotCode: "robot_1", ...over }
}

function req(conversationRef: Record<string, unknown>, segments: OutboundRequest["segments"]) {
  return {
    conversationRef: conversationRef as OutboundRequest["conversationRef"],
    segments,
    metadata: { idempotencyKey: "k-contract" },
  } satisfies OutboundRequest
}

function lastHttpCall(): {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  expect(mockHttp.mock.calls.length).toBeGreaterThan(0)
  const r = mockHttp.mock.calls.at(-1)![0] as {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }
  return {
    url: r.url,
    method: r.method,
    headers: r.headers,
    body: r.body ? JSON.parse(r.body) : {},
  }
}

describe("DingTalk adapter contract suite", () => {
  beforeEach(() => {
    mockHttp.mockReset()
    mockHttp.mockResolvedValue(okResp())
  })

  describe("send.text capability", () => {
    it("1:1 text becomes POST /v1.0/robot/oToMessages/batchSend with sampleText", async () => {
      const res = await makeAdapter().send(
        req(ref({ conversationType: "1", userId: "staff_1" }), [{ type: "text", text: "hello" }])
      )
      expect(res.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.method).toBe("POST")
      expect(call.url).toContain("/v1.0/robot/oToMessages/batchSend")
      expect(call.headers["x-acs-dingtalk-access-token"]).toBe("TOKEN")
      expect(call.body).toMatchObject({
        robotCode: "robot_1",
        userIds: ["staff_1"],
        msgKey: "sampleText",
      })
      expect(JSON.parse(call.body.msgParam as string)).toEqual({ content: "hello" })
    })

    it("group text becomes POST /v1.0/robot/groupMessages/send with the openConversationId", async () => {
      await makeAdapter().send(
        req(ref({ conversationType: "2", openConversationId: "cid_1" }), [
          { type: "text", text: "hello group" },
        ])
      )
      const call = lastHttpCall()
      expect(call.url).toContain("/v1.0/robot/groupMessages/send")
      expect(call.body).toMatchObject({ robotCode: "robot_1", openConversationId: "cid_1" })
    })
  })

  describe("send.markdown capability", () => {
    it("markdown becomes the sampleMarkdown template with title + text", async () => {
      await makeAdapter().send(
        req(ref({ conversationType: "1", userId: "staff_1" }), [
          { type: "markdown", md: "# Title\n\n**bold**" },
        ])
      )
      const call = lastHttpCall()
      expect(call.body.msgKey).toBe("sampleMarkdown")
      const param = JSON.parse(call.body.msgParam as string) as { title: string; text: string }
      expect(param.text).toContain("**bold**")
      expect(typeof param.title).toBe("string")
    })
  })

  describe("send.a2ui capability", () => {
    it("an A2UI surface projects to sampleMarkdown", async () => {
      await makeAdapter().send(
        req(ref({ conversationType: "1", userId: "staff_1" }), [
          {
            type: "a2ui",
            surfaceId: "s1",
            content: {
              root: "r",
              components: [{ id: "r", type: "Text", props: { text: "Hello surface" } }],
            } as never,
            plainTextMirror: "Hello surface",
          },
        ])
      )
      const call = lastHttpCall()
      expect(call.body.msgKey).toBe("sampleMarkdown")
      expect(JSON.parse(call.body.msgParam as string).text).toContain("Hello surface")
    })
  })

  describe("delete capability", () => {
    it("send() returns a robot+scene+processQueryKey id that delete() routes to the recall endpoint", async () => {
      const adapter = makeAdapter()
      const oto = await adapter.send(
        req(ref({ conversationType: "1", userId: "staff_1" }), [{ type: "text", text: "x" }])
      )
      expect(oto.platformMessageId).toBe("dt:oto:robot_1:-:pqk_1")
      mockHttp.mockResolvedValue(okResp({}))
      await adapter.delete!(oto.platformMessageId!)
      let call = lastHttpCall()
      expect(call.url).toContain("/v1.0/robot/otoMessages/batchRecall")
      expect(call.body).toEqual({ robotCode: "robot_1", processQueryKeys: ["pqk_1"] })

      await adapter.delete!("dt:group:robot_1:cid_1:pqk_2")
      call = lastHttpCall()
      expect(call.url).toContain("/v1.0/robot/groupMessages/recall")
      expect(call.body).toEqual({
        robotCode: "robot_1",
        openConversationId: "cid_1",
        processQueryKeys: ["pqk_2"],
      })
    })

    it("delete() rejects a bare processQueryKey (session-webhook sends are not recallable)", async () => {
      await expect(makeAdapter().delete!("pqk_bare")).rejects.toThrow(/processQueryKey/)
      expect(mockHttp).not.toHaveBeenCalled()
    })
  })

  describe("edit / typing / send.reaction / history.fetch (intentionally absent)", () => {
    it("declares none of them and implements no method for them (no bot-surface API)", () => {
      const adapter = makeAdapter()
      for (const cap of ["edit", "typing", "send.reaction", "history.fetch"] as const) {
        expect(adapter.meta.capabilities).not.toContain(cap)
      }
      expect(adapter.edit).toBeUndefined()
      expect(adapter.setTyping).toBeUndefined()
      expect(adapter.addReaction).toBeUndefined()
      expect(adapter.removeReaction).toBeUndefined()
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.streamReply).toBeUndefined()
    })
  })
})
