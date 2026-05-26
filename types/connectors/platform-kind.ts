/**
 * The set of platform connectors we plan to support across all phases. Each
 * built-in adapter binds 1:1 to one of these kinds; plugin-contributed
 * adapters can extend the union via module augmentation but must pick a
 * fresh string that does not collide with a built-in.
 */
export const ALL_PLATFORM_KINDS = [
  "telegram",
  "discord",
  "slack",
  "lark",
  "onebot",
  "dingtalk",
  "wecom",
  "wechat-oa",
  // Personal WeChat via the iLink (智联) half-official bot gateway
  // (`ilinkai.weixin.qq.com`). Distinct from `wechat-oa` (Official Account).
  "wechat-personal",
  "qq-official",
  "email",
  "matrix",
  "kook",
  "line",
  "mattermost",
  // Plugin-contributed: GitHub Delivery routes PR / Issue events to the
  // unified Inbox so review_requested / assigned events land alongside
  // platform messages. The github-delivery plugin owns the adapter and the
  // build/send/health surfaces are no-ops (use action.github.* workflow
  // nodes for outbound).
  "github",
] as const

export type PlatformKind = (typeof ALL_PLATFORM_KINDS)[number]

export function isPlatformKind(value: unknown): value is PlatformKind {
  return (
    typeof value === "string" &&
    (ALL_PLATFORM_KINDS as readonly PlatformKind[]).includes(value as PlatformKind)
  )
}
