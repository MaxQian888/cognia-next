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

/**
 * Ship status drives "available" / "beta" / "coming soon" badges in the inspector.
 *
 * `planned` is an **intentional dormancy** marker (CLAUDE.md working rule 7 —
 * documented at the type, labelled in the UI, pinned by a test): the
 * `PlatformKind` union reserves the id, but there is no adapter-registry
 * factory, no config dialog, and no i18n abbreviation. UI surfaces that read
 * this status:
 *   - `components/settings/connections/adapters/add-connector-grid.tsx` —
 *     planned kinds render as a disabled "Planned" card with no `onPick`
 *     (wired from `tabs/adapters-tab.tsx` via `listConnectorMetadata()`).
 *   - `components/inbox/platform-badge.tsx` — planned kinds render the generic
 *     two-letter fallback with a "Planned platform" title.
 * `platform-badge.test.tsx` + `add-connector-grid.test.tsx` pin both.
 */
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
 *   stable — native adapter-registry platforms that can be configured and
 *            started from Settings.
 *   planned — email / kook / line / mattermost (PlatformKind union reserves
 *             them; no native adapter factory branch yet).
 */
export const CONNECTOR_METADATA: readonly ConnectorMeta[] = [
  { type: "telegram", iconName: "Send", status: "stable", oauth: false, richMessages: true },
  { type: "discord", iconName: "MessageCircle", status: "stable", oauth: true, richMessages: true },
  { type: "slack", iconName: "Hash", status: "stable", oauth: true, richMessages: true },
  { type: "lark", iconName: "MessagesSquare", status: "stable", oauth: true, richMessages: true },
  { type: "onebot", iconName: "Bot", status: "stable", oauth: false, richMessages: false },
  { type: "email", iconName: "Mail", status: "planned", oauth: false, richMessages: false },
  {
    // Configured with an AppKey/AppSecret pair (keyring), not an OAuth flow.
    type: "dingtalk",
    iconName: "MessageSquare",
    status: "stable",
    oauth: false,
    richMessages: true,
  },
  { type: "wecom", iconName: "Building2", status: "stable", oauth: true, richMessages: true },
  {
    type: "wechat-oa",
    iconName: "MessageCircle",
    status: "stable",
    oauth: true,
    richMessages: false,
  },
  {
    // Personal WeChat (iLink) — long-poll bridge, reply-only. It ships as a
    // native adapter, but richMessages remains false because the protocol
    // cannot initiate proactive rich outbound in v1.
    type: "wechat-personal",
    iconName: "MessageCircle",
    status: "stable",
    oauth: false,
    richMessages: false,
  },
  { type: "qq-official", iconName: "Bot", status: "stable", oauth: true, richMessages: false },
  { type: "matrix", iconName: "Network", status: "stable", oauth: false, richMessages: true },
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
