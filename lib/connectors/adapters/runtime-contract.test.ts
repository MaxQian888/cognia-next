import { createTelegramAdapter } from "./telegram"
import { createDiscordAdapter } from "./discord"
import { createSlackAdapter } from "./slack"
import { createLarkAdapter } from "./lark"
import { createOneBotAdapter } from "./onebot"
import { createWeComAdapter } from "./wecom"
import { createWechatPersonalAdapter } from "./wechat-personal"
import { createMatrixAdapter } from "./matrix"
import { createQQOfficialAdapter } from "./qq-official"
import { createWechatOaAdapter } from "./wechat-oa"
import { createDingTalkAdapter } from "./dingtalk"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import { invoke } from "@tauri-apps/api/core"
import { serializeSend as serializeLarkSend } from "./lark/serialize"
import { discordNonce } from "./discord/serialize"

// The Matrix adapter constructs its E2EE runtime eagerly; a passthrough stub
// lets `send()` reach the HTTP layer without a Rust crypto store.
jest.mock("./matrix/e2ee", () => ({
  MatrixE2EERuntime: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    receiveSync: jest.fn(async () => undefined),
    prepareRoomEvent: jest.fn(async (_roomId: string, eventType: string, content: unknown) => ({
      eventType,
      content,
    })),
    decryptOrQueue: jest.fn(async (_roomId: string, event: unknown) => event),
    isRoomEncrypted: jest.fn(async () => false),
    canAdvanceCursor: () => true,
  })),
}))

const mockInvoke = invoke as jest.Mock
const secret = async () => "test"

/** Every `connectors_http_request` the adapters issued, oldest first. */
function httpRequests(): Array<{ method: string; url: string; body?: string }> {
  return mockInvoke.mock.calls
    .filter(([cmd]: [string]) => cmd === "connectors_http_request")
    .map((c) => (c[1] as { req: { method: string; url: string; body?: string } }).req)
}

function adapters(): PlatformAdapter[] {
  return [
    createTelegramAdapter({
      id: "telegram-contract",
      displayName: "Telegram",
      transport: "webhook",
      botToken: secret,
      selfId: "bot",
    }),
    createDiscordAdapter({
      id: "discord-contract",
      displayName: "Discord",
      botToken: secret,
      selfId: "bot",
      transportMode: "webhook",
    }),
    createSlackAdapter({
      id: "slack-contract",
      displayName: "Slack",
      botToken: secret,
      signingSecret: secret,
      selfId: "bot",
      transport: "events-api-webhook",
      assistantAppEnabled: true,
    }),
    createLarkAdapter({
      id: "lark-contract",
      displayName: "Lark",
      appId: secret,
      appSecret: secret,
      verificationToken: secret,
      selfBotOpenId: "bot",
      transport: "webhook",
    }),
    createOneBotAdapter({
      id: "onebot-contract",
      displayName: "OneBot",
      selfBotUin: "1",
      transportMode: "reverse-ws",
    }),
    createWeComAdapter({
      id: "wecom-contract",
      displayName: "WeCom",
      botId: secret,
      secret,
    }),
    createWechatPersonalAdapter({
      id: "wechat-personal-contract",
      displayName: "WeChat Personal",
      token: secret,
    }),
    createMatrixAdapter({
      id: "matrix-contract",
      displayName: "Matrix",
      homeserver: "https://matrix.example",
      accessToken: secret,
      selfId: "@bot:example",
      deviceId: "DEVICE",
    }),
    createQQOfficialAdapter({
      id: "qq-official-contract",
      displayName: "QQ Official",
      accessToken: secret,
      transportMode: "webhook",
    }),
    createWechatOaAdapter({
      id: "wechat-oa-contract",
      displayName: "WeChat OA",
      accessToken: secret,
    }),
    createDingTalkAdapter({
      id: "dingtalk-contract",
      displayName: "DingTalk",
      appKey: secret,
      appSecret: secret,
      accessToken: secret,
    }),
  ]
}

describe("built-in connector runtime contract", () => {
  it("allows remote_idempotent only when the real serializer propagates the stable key", async () => {
    const remoteIdempotent = adapters().filter(
      (adapter) => adapter.runtimeCapabilities?.ambiguousDelivery === "remote_idempotent"
    )
    // Sorted so the assertion below is order-independent.
    expect(remoteIdempotent.map((adapter) => adapter.meta.type).sort()).toEqual([
      "discord",
      "lark",
      "matrix",
    ])

    for (const adapter of remoteIdempotent) {
      mockInvoke.mockReset()
      const key = "stable-contract-key"
      if (adapter.meta.type === "lark") {
        const request = {
          conversationRef: { platform: "lark" as const, adapterId: adapter.id, channelId: "oc_c" },
          segments: [{ type: "text" as const, text: "contract" }],
          metadata: { idempotencyKey: key },
        }
        // Lark: message-create `uuid` IS the idempotency key.
        expect(serializeLarkSend(request).payload["uuid"]).toBe(key)
        continue
      }
      if (adapter.meta.type === "discord") {
        mockInvoke.mockResolvedValue({
          status: 200,
          headers: {},
          body: JSON.stringify({ id: "1" }),
        })
        const result = await adapter.send({
          conversationRef: { platform: "discord", adapterId: adapter.id, channelId: "c1" },
          segments: [{ type: "text", text: "contract" }],
          metadata: { idempotencyKey: key },
        })
        expect(result.ok).toBe(true)
        const [call] = httpRequests()
        expect(call.method).toBe("POST")
        expect(call.url).toMatch(/\/channels\/c1\/messages$/)
        // Discord: `nonce` derived from the key + `enforce_nonce: true`.
        expect(JSON.parse(call.body!)).toMatchObject({
          nonce: discordNonce(key, 0),
          enforce_nonce: true,
        })
        continue
      }
      if (adapter.meta.type === "matrix") {
        mockInvoke.mockResolvedValue({
          status: 200,
          headers: {},
          body: JSON.stringify({ event_id: "$e" }),
        })
        const result = await adapter.send({
          conversationRef: { platform: "matrix", adapterId: adapter.id, roomId: "!r:example" },
          segments: [{ type: "text", text: "contract" }],
          metadata: { idempotencyKey: key },
        })
        expect(result.ok).toBe(true)
        const [call] = httpRequests()
        expect(call.method).toBe("PUT")
        // Matrix: the txnId path segment IS the idempotency key (+ chunk index).
        expect(call.url).toContain(`/send/m.room.message/${encodeURIComponent(`${key}:0`)}`)
        continue
      }
      throw new Error(
        `${adapter.meta.type} declares remote_idempotent without a serializer contract assertion`
      )
    }
  })

  it.each(adapters().map((adapter) => [adapter.meta.type, adapter] as const))(
    "%s declares isolation, degradation, and ambiguous-delivery behavior",
    (_platform, adapter) => {
      const capabilities = adapter.runtimeCapabilities
      expect(capabilities).toBeDefined()
      expect(["native", "unsupported"]).toContain(capabilities?.topicIsolation)
      expect(["remote_idempotent", "reconciliation_required"]).toContain(
        capabilities?.ambiguousDelivery
      )
      expect(
        capabilities?.textStreaming || capabilities?.messageEditing || capabilities?.appendFallback
      ).toBe(true)
    }
  )

  it.each(adapters().map((adapter) => [adapter.meta.type, adapter] as const))(
    "%s round-trips a complete adapter-owned delivery target without parsing its key",
    (_platform, adapter) => {
      const target: ConversationDeliveryTarget = {
        address: {
          conversationKey: `opaque/${adapter.id}/container/topic`,
          platform: adapter.meta.type,
          adapterId: adapter.id,
          scopeKind: adapter.runtimeCapabilities?.topicIsolation === "native" ? "thread" : "group",
          containerId: "container:with:separators",
          ...(adapter.runtimeCapabilities?.topicIsolation === "native"
            ? { topicId: "topic:with:separators" }
            : {}),
        },
        conversationRef: {
          platform: adapter.meta.type,
          adapterId: adapter.id,
          opaque: { container: "container:with:separators", topic: "topic:with:separators" },
        },
        sourceMessageId: "source:message",
        refreshedAt: 1,
      }

      expect(JSON.parse(JSON.stringify(target))).toEqual(target)
      if (adapter.runtimeCapabilities?.topicIsolation === "unsupported") {
        expect(target.address.topicId).toBeUndefined()
      } else {
        expect(target.address.topicId).toBe("topic:with:separators")
      }
    }
  )
})
