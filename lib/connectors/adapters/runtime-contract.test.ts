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
import { serializeSend as serializeLarkSend } from "./lark/serialize"

const secret = async () => "test"

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
  it("allows remote_idempotent only when the real serializer propagates the stable key", () => {
    const remoteIdempotent = adapters().filter(
      (adapter) => adapter.runtimeCapabilities?.ambiguousDelivery === "remote_idempotent"
    )

    for (const adapter of remoteIdempotent) {
      const request = {
        conversationRef: {
          platform: adapter.meta.type,
          adapterId: adapter.id,
          channelId: "oc_contract",
        },
        segments: [{ type: "text" as const, text: "contract" }],
        metadata: { idempotencyKey: "stable-contract-key" },
      }
      if (adapter.meta.type === "lark") {
        expect(serializeLarkSend(request).payload["uuid"]).toBe("stable-contract-key")
        continue
      }
      throw new Error(
        `${adapter.meta.type} declares remote_idempotent without a serializer contract assertion`
      )
    }

    expect(remoteIdempotent.map((adapter) => adapter.meta.type)).toEqual(["lark"])
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
