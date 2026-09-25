/**
 * What the desktop chat copilot knows about a chat app's layout (ADR-0194 §8).
 *
 * Reading sides off a screenshot only works where the app draws the user's own
 * messages on one side and everyone else's on the other. For an app not listed
 * here the grouper infers it from the frame, and it only trusts the inference
 * when both sides actually appear; an app known to put everything in one
 * column (Slack, Discord, Teams) is never given sides, because "all on the
 * left" there says nothing about who wrote what.
 */

export type ChatLayout = "two_sided" | "single_column" | "unknown"

interface KnownChatApp {
  id: string
  layout: Exclude<ChatLayout, "unknown">
  /** macOS bundle identifiers. */
  bundleIds: readonly string[]
  /** Normalized process / display names (lowercase, no `.exe`). */
  names: readonly string[]
}

export const KNOWN_CHAT_APPS: readonly KnownChatApp[] = [
  {
    id: "wechat",
    layout: "two_sided",
    bundleIds: ["com.tencent.xinWeChat"],
    names: ["wechat", "weixin", "微信"],
  },
  { id: "qq", layout: "two_sided", bundleIds: ["com.tencent.qq"], names: ["qq"] },
  {
    id: "wecom",
    layout: "two_sided",
    bundleIds: ["com.tencent.WeWorkMac"],
    names: ["wxwork", "wecom", "企业微信"],
  },
  {
    id: "dingtalk",
    layout: "two_sided",
    bundleIds: ["com.alibaba.DingTalkMac"],
    names: ["dingtalk", "钉钉"],
  },
  {
    id: "telegram",
    layout: "two_sided",
    bundleIds: ["ru.keepcoder.Telegram", "org.telegram.desktop"],
    names: ["telegram", "telegram desktop"],
  },
  {
    id: "whatsapp",
    layout: "two_sided",
    bundleIds: ["net.whatsapp.WhatsApp", "desktop.WhatsApp"],
    names: ["whatsapp"],
  },
  { id: "messages", layout: "two_sided", bundleIds: ["com.apple.MobileSMS"], names: ["messages"] },
  { id: "line", layout: "two_sided", bundleIds: ["jp.naver.line.mac"], names: ["line"] },
  {
    id: "signal",
    layout: "two_sided",
    bundleIds: ["org.whispersystems.signal-desktop"],
    names: ["signal"],
  },
  {
    id: "slack",
    layout: "single_column",
    bundleIds: ["com.tinyspeck.slackmacgap"],
    names: ["slack"],
  },
  { id: "discord", layout: "single_column", bundleIds: ["com.hnc.Discord"], names: ["discord"] },
  {
    id: "teams",
    layout: "single_column",
    bundleIds: ["com.microsoft.teams2", "com.microsoft.teams"],
    names: ["ms-teams", "teams", "microsoft teams"],
  },
]

function normalizeAppName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
}

export interface ChatAppIdentity {
  appName: string
  bundleId?: string | null
}

export interface ResolvedChatApp {
  /** Known app id, or null for an app this table does not list. */
  id: string | null
  layout: ChatLayout
}

export function resolveChatApp(app: ChatAppIdentity): ResolvedChatApp {
  const bundleId = app.bundleId?.trim()
  const name = normalizeAppName(app.appName)
  const known = KNOWN_CHAT_APPS.find(
    (candidate) =>
      (bundleId && candidate.bundleIds.includes(bundleId)) || candidate.names.includes(name)
  )
  return known ? { id: known.id, layout: known.layout } : { id: null, layout: "unknown" }
}
