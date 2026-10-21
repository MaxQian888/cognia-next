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
] as const

export type BuiltInPlatformKind = (typeof ALL_PLATFORM_KINDS)[number]

/**
 * Built-in platform ids plus plugin-owned ids. The open string branch is
 * intentional: TypeScript connector plugins can implement a new IM platform
 * without modifying the host's business model.
 */
export type PlatformKind = BuiltInPlatformKind | (string & {})

/** Runtime check for host-built platform ids (plugin ids are registry-owned). */
export function isPlatformKind(value: unknown): value is BuiltInPlatformKind {
  return (
    typeof value === "string" &&
    (ALL_PLATFORM_KINDS as readonly BuiltInPlatformKind[]).includes(value as BuiltInPlatformKind)
  )
}
