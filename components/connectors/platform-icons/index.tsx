"use client"

/**
 * Vendored platform brand icons.
 *
 * A single source of truth for the glyph shown per connector platform across
 * the Inbox `PlatformBadge` and the Settings adapter list/detail. Brand path
 * data for Telegram / Discord / Slack / Matrix / WeChat / QQ is vendored from
 * Simple Icons (CC0, https://simpleicons.org) so we get real, recognizable
 * marks without adding an npm dependency — the SVGs use `currentColor` so the
 * caller's `colorClass` tints them.
 *
 * DingTalk is not in Simple Icons, so its mark is vendored from Remix Icon
 * (`ri:dingding-fill`, Apache-2.0, https://remixicon.com) — same 24×24
 * currentColor convention.
 *
 * Platforms with no vendored brand mark keep a clean lucide glyph:
 *   - Lark/Feishu → bird (Lark ≙ bird).
 *   - WeCom / WeChat OA → share the WeChat brand mark (same family; the
 *     per-platform colour distinguishes them in the badge).
 *   - OneBot (QQ via NapCat/Lagrange) → shares the QQ brand mark.
 *   - Email / KOOK / LINE / Mattermost / GitHub / unknown → lucide fallbacks
 *     so every kind still renders a distinct glyph.
 */

import { createElement } from "react"
import type { LucideIcon } from "lucide-react"
import { BirdIcon, GitBranchIcon, HashIcon, MailIcon, MessageCircleIcon } from "lucide-react"

import {
  isPlatformKind,
  type BuiltInPlatformKind,
  type PlatformKind,
} from "@/types/connectors/platform-kind"

export type PlatformIconComponent = React.ComponentType<{ className?: string }>

interface BrandGlyphProps {
  className?: string
}

/** Wrap a vendored Simple Icons path in a consistent 24×24 currentColor svg. */
function brandIcon(path: string, title: string): PlatformIconComponent {
  function BrandIcon({ className }: BrandGlyphProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="currentColor"
        role="img"
        aria-label={title}
      >
        <path d={path} />
      </svg>
    )
  }
  BrandIcon.displayName = `${title}Icon`
  return BrandIcon
}

// Simple Icons path data (CC0).
const TELEGRAM_PATH =
  "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
const DISCORD_PATH =
  "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
const SLACK_PATH =
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
const MATRIX_PATH =
  "M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.481.314.448.208.785.582 1.02 1.108.254-.374.6-.706 1.034-.992.434-.287.95-.43 1.546-.43.453 0 .872.056 1.26.167.388.11.716.286.993.53.276.245.489.559.646.951.152.392.23.863.23 1.417v5.728h-2.349V11.52c0-.286-.01-.559-.032-.812a1.755 1.755 0 0 0-.18-.66 1.106 1.106 0 0 0-.438-.448c-.194-.11-.457-.166-.785-.166-.332 0-.6.064-.803.189a1.38 1.38 0 0 0-.48.499 1.946 1.946 0 0 0-.231.696 5.56 5.56 0 0 0-.06.785v4.768h-2.35v-4.8c0-.254-.004-.503-.018-.752a2.074 2.074 0 0 0-.143-.688 1.052 1.052 0 0 0-.415-.503c-.194-.125-.476-.19-.854-.19-.111 0-.259.024-.439.074-.18.051-.36.143-.53.282-.171.138-.319.337-.439.595-.12.259-.18.6-.18 1.02v4.966H5.46V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z"
const WECHAT_PATH =
  "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"
const QQ_PATH =
  "M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"
// Remix Icon `ri:dingding-fill` (Apache-2.0) — Simple Icons has no DingTalk mark.
const DINGTALK_PATH =
  "M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10S17.523 2 12 2m4.49 9.04l-.006.014c-.42.898-1.516 2.66-1.516 2.66l-.005-.012l-.32.558h1.543l-2.948 3.919l.67-2.666h-1.215l.422-1.763a17 17 0 0 0-1.223.349s-.646.378-1.862-.729c0 0-.82-.722-.344-.902c.202-.077.981-.175 1.595-.257a80 80 0 0 1 1.338-.172s-2.555.039-3.161-.057c-.606-.095-1.375-1.107-1.539-1.996c0 0-.253-.488.545-.257s4.101.9 4.101.9S8.27 9.312 7.983 8.99c-.286-.32-.841-1.754-.769-2.634c0 0 .031-.22.257-.16c0 0 3.176 1.45 5.347 2.245s4.06 1.199 3.816 2.228c-.02.087-.072.216-.144.37"

const TelegramIcon = brandIcon(TELEGRAM_PATH, "Telegram")
const DiscordIcon = brandIcon(DISCORD_PATH, "Discord")
const SlackIcon = brandIcon(SLACK_PATH, "Slack")
const MatrixIcon = brandIcon(MATRIX_PATH, "Matrix")
const WeChatIcon = brandIcon(WECHAT_PATH, "WeChat")
const QQIcon = brandIcon(QQ_PATH, "QQ")
const DingTalkIcon = brandIcon(DINGTALK_PATH, "DingTalk")

/**
 * Per-platform glyph. Brand SVGs where available; lucide fallbacks otherwise.
 */
const PLATFORM_ICON: Record<BuiltInPlatformKind, PlatformIconComponent> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
  slack: SlackIcon,
  matrix: MatrixIcon,
  lark: BirdIcon,
  onebot: QQIcon,
  "qq-official": QQIcon,
  wecom: WeChatIcon,
  "wechat-oa": WeChatIcon,
  "wechat-personal": WeChatIcon,
  dingtalk: DingTalkIcon,
  email: MailIcon,
  kook: MessageCircleIcon,
  line: MessageCircleIcon,
  mattermost: HashIcon,
  github: GitBranchIcon,
}

const FALLBACK_ICON: PlatformIconComponent = MessageCircleIcon as unknown as PlatformIconComponent

/** Resolve the glyph component for a platform kind (never returns undefined). */
export function getPlatformIcon(kind: PlatformKind): PlatformIconComponent {
  return isPlatformKind(kind) ? PLATFORM_ICON[kind] : FALLBACK_ICON
}

/**
 * Render the glyph for a platform kind. A stable, module-scope component so
 * callers don't bind a dynamically-resolved component to a render-local
 * variable (which trips `react-hooks/static-components`). Uses `createElement`
 * because the resolved glyph is data, not an inline component definition.
 */
export function PlatformIcon({ kind, className }: { kind: PlatformKind; className?: string }) {
  return createElement(getPlatformIcon(kind), { className })
}

export type { LucideIcon }
