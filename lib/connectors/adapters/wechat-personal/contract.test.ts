// Adapter contract suite for WeChat Personal (iLink bot) — mirrors
// `telegram/contract.test.ts`. One `describe` per declared Capability: build
// adapter → route `ctx.tauri.httpRequest` by URL → call the adapter method →
// assert the iLink `sendmessage` body. Plus one "intentionally absent" case
// per mutation method the adapter does NOT declare (ADR-0036 non-goals:
// reply-only, no outbound media in v1, no streaming).

import { createWechatPersonalAdapter } from "./index"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { WechatPersonalConversationRef } from "./parse"

jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))
// The A2UI mapper records callback bindings in Dexie; keep the contract test
// in the fast node env by short-circuiting to a plain text mirror.
jest.mock("./a2ui-mapper", () => ({
  ...jest.requireActual("./a2ui-mapper"),
  buildIlinkA2UISurface: jest.fn(async ({ segment }: { segment: { plainTextMirror: string } }) => ({
    textMirror: `${segment.plainTextMirror}\n\n回复数字选择：1) Go`,
    numberedCount: 1,
  })),
}))

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeCtx(sendMessage: () => unknown = () => ({ ret: 0 })) {
  const http = jest.fn(async (req: { url: string }) => {
    const body = req.url.includes("getupdates") ? { ret: -14 } : sendMessage()
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  })
  const ctx = {
    emit: jest.fn(async () => undefined),
    tauri: {
      httpRequest: http,
      fetchAttachment: jest.fn(async () => ({ localUrl: "file:///x", remoteRef: "r" })),
    } as unknown as AdapterContext["tauri"],
    secrets: {} as AdapterContext["secrets"],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    adapterId: "wx-contract",
  } as unknown as AdapterContext
  return { ctx, http }
}

function makeAdapter() {
  return createWechatPersonalAdapter({
    id: "wx-contract",
    displayName: "Contract WeChat",
    token: async () => "tok",
    baseUrl: async () => "https://base",
    _backoffBaseMs: 1,
  })
}

const REF: WechatPersonalConversationRef = {
  platform: "wechat-personal",
  adapterId: "wx-contract",
  userId: "alice@im.wechat",
  contextToken: "ctx-9",
}

function req(
  segments: OutboundRequest["segments"],
  ref: OutboundRequest["conversationRef"] = REF
): OutboundRequest {
  return { conversationRef: ref, segments, metadata: { idempotencyKey: "k-contract" } }
}

function sendBodies(http: jest.Mock): Array<Record<string, unknown>> {
  return http.mock.calls
    .filter((c) => (c[0] as { url: string }).url.includes("sendmessage"))
    .map((c) => JSON.parse((c[0] as { body: string }).body) as Record<string, unknown>)
}

async function started() {
  const { ctx, http } = makeCtx()
  const adapter = makeAdapter()
  await adapter.start(ctx)
  await tick()
  return { adapter, http }
}

describe("WeChat Personal adapter contract suite", () => {
  describe("send.text capability", () => {
    it("text becomes an iLink sendmessage text_item echoing the context_token", async () => {
      const { adapter, http } = await started()
      const res = await adapter.send(req([{ type: "text", text: "hi back" }]))
      expect(res.ok).toBe(true)
      const [body] = sendBodies(http)
      const msg = body.msg as Record<string, unknown>
      expect(msg.context_token).toBe("ctx-9")
      expect(msg.to_user_id).toBe("alice@im.wechat")
      expect((msg.item_list as Array<{ text_item: { text: string } }>)[0].text_item.text).toBe(
        "hi back"
      )
      await adapter.stop()
    })

    it("refuses a proactive send without a context_token (reply-only surface)", async () => {
      const { adapter, http } = await started()
      const res = await adapter.send(
        req([{ type: "text", text: "ping" }], {
          platform: "wechat-personal",
          adapterId: "wx-contract",
          userId: "bob@im.wechat",
        })
      )
      expect(res.ok).toBe(false)
      expect(res.error?.code).toBe("unsupported_segment")
      expect(sendBodies(http)).toHaveLength(0)
      await adapter.stop()
    })
  })

  describe("send.a2ui capability", () => {
    it("an A2UI surface degrades to its numbered text mirror in the same text_item lane", async () => {
      const { adapter, http } = await started()
      const res = await adapter.send(
        req([
          {
            type: "a2ui",
            surfaceId: "s1",
            content: { root: "r", components: [] } as never,
            plainTextMirror: "Pick one",
          },
        ])
      )
      expect(res.ok).toBe(true)
      const [body] = sendBodies(http)
      const text = (body.msg as { item_list: Array<{ text_item: { text: string } }> }).item_list[0]
        .text_item.text as string
      expect(text).toContain("Pick one")
      expect(text).toContain("1) Go")
      await adapter.stop()
    })
  })

  describe("edit / delete / typing / send.reaction / history.fetch / send.image (intentionally absent)", () => {
    it("declares none of them and implements no method for them", () => {
      const adapter = makeAdapter()
      for (const cap of [
        "edit",
        "delete",
        "typing",
        "send.reaction",
        "history.fetch",
        "send.image",
        "send.file",
        "send.voice",
        "send.video",
      ] as const) {
        expect(adapter.meta.capabilities).not.toContain(cap)
      }
      expect(adapter.edit).toBeUndefined()
      expect(adapter.delete).toBeUndefined()
      expect(adapter.setTyping).toBeUndefined()
      expect(adapter.addReaction).toBeUndefined()
      expect(adapter.removeReaction).toBeUndefined()
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.streamReply).toBeUndefined()
    })
  })
})
