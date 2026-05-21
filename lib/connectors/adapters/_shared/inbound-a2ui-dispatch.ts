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
import type { InboundA2UIBlock } from "./inbound-a2ui-types"
import { slackInboundToA2UI } from "../slack/inbound-to-a2ui"
import { larkInboundToA2UI } from "../lark/inbound-to-a2ui"
import { discordInboundToA2UI } from "../discord/inbound-to-a2ui"
import { telegramInboundToA2UI } from "../telegram/inbound-to-a2ui"
import { onebotInboundToA2UI } from "../onebot/inbound-to-a2ui"

export function projectInboundToA2UI(
  platform: PlatformKind,
  rawPayload: unknown
): InboundA2UIBlock | null {
  if (!rawPayload || typeof rawPayload !== "object") return null
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
