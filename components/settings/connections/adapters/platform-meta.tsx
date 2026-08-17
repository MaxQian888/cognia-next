"use client"

/**
 * Platform → { label key, icon } lookup for the Adapters list + detail
 * header. Icons come from the shared vendored brand set
 * (`@/components/connectors/platform-icons`) so the Settings list and the
 * Inbox badge render the same glyph. `labelKey` is the suffix under the
 * `settings.connections.adapters.platforms.*` i18n namespace — callers
 * resolve it with `t(\`platforms.${meta.labelKey}\`)`. Every built-in
 * `PlatformKind` has a label — including the four `planned` kinds
 * (email / kook / line / mattermost, see `ConnectorMeta.status`) so the
 * "Planned" cards in the Add-connector grid read as real platforms. Plugin
 * ids and anything else fall back to `"unknown"` for the label while still
 * getting a sensible glyph from `getPlatformIcon`.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { TransportMode } from "@/types/connectors/adapter"
import { getPlatformIcon, type PlatformIconComponent } from "@/components/connectors/platform-icons"

export interface PlatformMeta {
  /** i18n key suffix under `settings.connections.adapters.platforms`. */
  labelKey: string
  Icon: PlatformIconComponent
}

/** Built-in platforms with a translated label (buildable + planned). */
const LABEL_KEY: Partial<Record<PlatformKind, string>> = {
  telegram: "telegram",
  discord: "discord",
  slack: "slack",
  lark: "lark",
  onebot: "onebot",
  wecom: "wecom",
  "wechat-personal": "wechat-personal",
  "wechat-oa": "wechat-oa",
  "qq-official": "qq-official",
  matrix: "matrix",
  dingtalk: "dingtalk",
  // Planned (no factory / dialog yet) — labelled so the grid can show them.
  email: "email",
  kook: "kook",
  line: "line",
  mattermost: "mattermost",
}

export function getPlatformMeta(kind: PlatformKind): PlatformMeta {
  return {
    labelKey: LABEL_KEY[kind] ?? "unknown",
    Icon: getPlatformIcon(kind),
  }
}

export function getAdapterTransportLabelKey(
  kind: PlatformKind,
  transportMode: TransportMode
): string | null {
  if (kind === "dingtalk" && transportMode === "longpoll") {
    return "transportLabels.dingtalkStream"
  }
  return null
}
