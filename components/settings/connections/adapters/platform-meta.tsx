"use client"

/**
 * Platform → { label key, icon } lookup for the Adapters list + detail
 * header. There are no brand SVGs in the repo, so each platform maps to a
 * distinct lucide glyph. `labelKey` is the suffix under the
 * `settings.connections.adapters.platforms.*` i18n namespace — callers
 * resolve it with `t(\`platforms.${meta.labelKey}\`)`. Kinds without a
 * configuration dialog (and any future plugin-contributed kind) fall back
 * to a generic chat glyph so the list never renders a blank icon.
 */

import type { LucideIcon } from "lucide-react"
import {
  BirdIcon,
  BotIcon,
  BuildingIcon,
  HashIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  SendIcon,
  SmartphoneIcon,
} from "lucide-react"

import type { PlatformKind } from "@/types/connectors/platform-kind"

export interface PlatformMeta {
  /** i18n key suffix under `settings.connections.adapters.platforms`. */
  labelKey: string
  Icon: LucideIcon
}

const META: Partial<Record<PlatformKind, PlatformMeta>> = {
  telegram: { labelKey: "telegram", Icon: SendIcon },
  discord: { labelKey: "discord", Icon: MessagesSquareIcon },
  slack: { labelKey: "slack", Icon: HashIcon },
  lark: { labelKey: "lark", Icon: BirdIcon },
  onebot: { labelKey: "onebot", Icon: BotIcon },
  wecom: { labelKey: "wecom", Icon: BuildingIcon },
  "wechat-personal": { labelKey: "wechat-personal", Icon: SmartphoneIcon },
}

const FALLBACK: PlatformMeta = { labelKey: "unknown", Icon: MessageCircleIcon }

export function getPlatformMeta(kind: PlatformKind): PlatformMeta {
  return META[kind] ?? FALLBACK
}
