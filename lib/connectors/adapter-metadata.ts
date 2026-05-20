/**
 * Display metadata for every platform kind cognia-next can adapt to.
 *
 * `lib/connectors/adapter-registry.ts` is the runtime factory — it only
 * answers "given a row of type X, build the adapter". The Discover page
 * needs the dual: "tell the user about all the platforms we support
 * (regardless of whether they have an instance configured)". This module
 * owns that registry without coupling it to the adapter factory.
 *
 * Labels + descriptions are exposed as i18n key fragments resolved at
 * render time via `discover.connectorLabels.{type}` and
 * `discover.connectorDescriptions.{type}`, so this file stays pure data
 * (no React, no next-intl).
 */

import { ALL_PLATFORM_KINDS, type PlatformKind } from "@/types/connectors/platform-kind"

/** Ship status drives "available" / "beta" / "coming soon" badges in the inspector. */
export type ConnectorStatus = "stable" | "beta" | "planned"

export interface ConnectorMeta {
  type: PlatformKind
  /** lucide-react icon name resolved at render time. */
  iconName: string
  /** Shipping maturity — drives the badge shown next to the name. */
  status: ConnectorStatus
  /** Whether the platform's onboarding requires an OAuth round-trip. */
  oauth: boolean
  /** Whether outbound messages support A2UI rich surfaces (Block Kit, Lark cards, …). */
  richMessages: boolean
}

/**
 * Per-platform metadata. Order is the display order for the discover grid.
 * The `status` field reflects what's actually shipped in adapter-registry:
 *   stable — telegram, discord, slack, lark, onebot (Phase-1 builtins)
 *   beta   — github (delivery plugin; inbox-only no outbound)
 *   planned — wecom / dingtalk / wechat-oa / qq-official / email / matrix /
 *             kook / line / mattermost (PlatformKind union allows them; no
 *             adapter factory branch yet)
 */
export const CONNECTOR_METADATA: readonly ConnectorMeta[] = [
  { type: "telegram", iconName: "Send", status: "stable", oauth: false, richMessages: true },
  { type: "discord", iconName: "MessageCircle", status: "stable", oauth: true, richMessages: true },
  { type: "slack", iconName: "Hash", status: "stable", oauth: true, richMessages: true },
  { type: "lark", iconName: "MessagesSquare", status: "stable", oauth: true, richMessages: true },
  { type: "onebot", iconName: "Bot", status: "stable", oauth: false, richMessages: false },
  { type: "github", iconName: "Github", status: "beta", oauth: true, richMessages: false },
  { type: "email", iconName: "Mail", status: "planned", oauth: false, richMessages: false },
  {
    type: "dingtalk",
    iconName: "MessageSquare",
    status: "planned",
    oauth: true,
    richMessages: true,
  },
  { type: "wecom", iconName: "Building2", status: "planned", oauth: true, richMessages: true },
  {
    type: "wechat-oa",
    iconName: "MessageCircle",
    status: "planned",
    oauth: true,
    richMessages: true,
  },
  { type: "qq-official", iconName: "Bot", status: "planned", oauth: true, richMessages: true },
  { type: "matrix", iconName: "Network", status: "planned", oauth: false, richMessages: false },
  { type: "kook", iconName: "MessageCircle", status: "planned", oauth: true, richMessages: true },
  { type: "line", iconName: "MessageCircle", status: "planned", oauth: true, richMessages: true },
  {
    type: "mattermost",
    iconName: "MessageSquare",
    status: "planned",
    oauth: true,
    richMessages: true,
  },
]

const META_BY_TYPE: ReadonlyMap<PlatformKind, ConnectorMeta> = new Map(
  CONNECTOR_METADATA.map((m) => [m.type, m])
)

export function getConnectorMeta(type: PlatformKind): ConnectorMeta | undefined {
  return META_BY_TYPE.get(type)
}

export function listConnectorMetadata(): readonly ConnectorMeta[] {
  return CONNECTOR_METADATA
}

/**
 * Self-check helper: returns the PlatformKind entries that have no metadata
 * row. The test suite uses this to keep `CONNECTOR_METADATA` aligned with
 * `ALL_PLATFORM_KINDS` so a new platform added to the union forces a
 * matching row here.
 */
export function findMetadataGaps(): PlatformKind[] {
  return ALL_PLATFORM_KINDS.filter((k) => !META_BY_TYPE.has(k))
}
