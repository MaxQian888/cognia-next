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
  "qq-official",
  "email",
  "matrix",
  "kook",
  "line",
  "mattermost",
] as const

export type PlatformKind = (typeof ALL_PLATFORM_KINDS)[number]

export function isPlatformKind(value: unknown): value is PlatformKind {
  return (
    typeof value === "string" &&
    (ALL_PLATFORM_KINDS as readonly PlatformKind[]).includes(value as PlatformKind)
  )
}
