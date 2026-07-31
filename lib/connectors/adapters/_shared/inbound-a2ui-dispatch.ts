/**
 * Per-platform dispatcher for `inboundToA2UI` projections.
 *
 * The bus calls this once per inbound `create` event so the resulting
 * `InboundA2UIBlock` can be persisted onto `StoredMessage.metadata`
 * for the Inbox renderer to pick up. Adapters that don't have a mapper
 * or whose payload doesn't produce any rich structure return `null`
 * and the bus falls through to plaintext rendering.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { MessageSegment } from "@/types/connectors/segment"
import type { InboundA2UIBlock } from "./inbound-a2ui-types"
import { slackInboundToA2UI } from "../slack/inbound-to-a2ui"
import { larkInboundToA2UI } from "../lark/inbound-to-a2ui"
import { discordInboundToA2UI } from "../discord/inbound-to-a2ui"
import { telegramInboundToA2UI } from "../telegram/inbound-to-a2ui"
import { onebotInboundToA2UI } from "../onebot/inbound-to-a2ui"
import { wecomInboundToA2UI } from "../wecom/inbound-to-a2ui"
import { wechatPersonalInboundToA2UI } from "../wechat-personal/inbound-to-a2ui"
import { wechatOaInboundToA2UI } from "../wechat-oa/inbound-to-a2ui"
import { matrixInboundToA2UI } from "../matrix/inbound-to-a2ui"
import { qqOfficialInboundToA2UI } from "../qq-official/inbound-to-a2ui"
import { dingtalkInboundToA2UI } from "../dingtalk/inbound-to-a2ui"

export function projectInboundToA2UI(
  platform: PlatformKind,
  rawPayload: unknown,
  /**
   * The normalized event's segments, when the caller has them. Mappers whose
   * raw payload carries platform-internal media refs (Matrix `mxc://`) use
   * these to surface the parser-resolved download URL / inlined bytes instead
   * of a URI no browser can load.
   */
  segments?: MessageSegment[]
): InboundA2UIBlock | null {
  // `wechat-oa` hands us the inbound XML as a string; every other adapter
  // hands an object. Only reject nullish payloads here and let each mapper
  // validate its own shape (the try/catch below contains any surprise).
  if (rawPayload == null) return null
  try {
    switch (platform) {
      case "slack":
        return slackInboundToA2UI(rawPayload as never)
      case "lark":
        return larkInboundToA2UI(rawPayload as never)
      case "discord":
        return discordInboundToA2UI(rawPayload as never)
      case "telegram":
        return telegramInboundToA2UI(rawPayload as never)
      case "onebot":
        return onebotInboundToA2UI(rawPayload as never)
      case "wecom":
        return wecomInboundToA2UI(rawPayload as never)
      case "wechat-personal":
        return wechatPersonalInboundToA2UI(rawPayload as never)
      case "wechat-oa":
        return wechatOaInboundToA2UI(rawPayload as never)
      case "matrix":
        return matrixInboundToA2UI(rawPayload as never, { segments })
      case "qq-official":
        return qqOfficialInboundToA2UI(rawPayload as never)
      case "dingtalk":
        return dingtalkInboundToA2UI(rawPayload as never)
      default:
        return null
    }
  } catch (err) {
    // Mappers are best-effort. A malformed payload from the platform
    // should never break the bus dispatch path.
    console.warn(
      `[inbound-a2ui-dispatch] ${platform} mapper threw:`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}
