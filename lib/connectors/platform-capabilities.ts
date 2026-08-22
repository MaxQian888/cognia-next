/**
 * Static `PlatformKind → Capability[]` lookup.
 *
 * Each built-in adapter declares its channel capabilities as a frozen
 * `*_CAPS` const (see `lib/connectors/adapters/<platform>/capability.ts`) and
 * pins it onto its descriptor (`PlatformAdapter.capabilities`). Those consts
 * are static per platform — they don't vary per adapter instance — so this
 * module re-exports them through a single by-platform map for callers that
 * need a channel's declared capabilities WITHOUT building a live adapter
 * (which is async and credential-bound).
 *
 * Used by the built-in skill manifest's `requires` filter
 * (`lib/skills/built-in/manifest.ts`) so a skill that needs a channel
 * capability (e.g. `rich-card.lark` to render its HITL confirm card) is
 * dropped from channels that don't declare it.
 *
 * Platforms without a dedicated `*_CAPS` const (email, kook, line,
 * mattermost, github) resolve to `[]` — treated as "declares no
 * capabilities", which conservatively drops any skill that `requires` one.
 *
 * A declared flag is platform-wide; a few are SCENE-LIMITED at the wire and
 * the adapter throws `unsupported` (or silently no-ops for `typing`) outside
 * the scene, and several more depend on what one INSTANCE was granted or
 * probed. Callers deciding whether something will work must read
 * `lib/connectors/effective-capabilities.ts` instead — this table is its
 * input, not the answer.
 *
 * The first two limits below resolve at (instance × scene) and ARE encoded
 * there. The last two do not: they are properties of an individual message or
 * recipient, so only the adapter can evaluate them and only at call time.
 *   - qq-official `typing`        → C2C only (`msg_type: 6 input_notify`,
 *                                   a passive reply that consumes one of the
 *                                   inbound msg_id's 5 slots).
 *   - qq-official `send.reaction` → guild `channel` scene only.
 *   - dingtalk `delete`           → only messages sent through the proactive
 *                                   endpoints (session-webhook sends return no
 *                                   `processQueryKey` and cannot be recalled).
 *   - wechat-oa `typing`          → same 48h customer-service window as sends.
 */

import type { Capability } from "@/types/connectors/capability"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { DINGTALK_CAPS } from "./adapters/dingtalk/capability"
import { DISCORD_CAPS } from "./adapters/discord/capability"
import { LARK_CAPS } from "./adapters/lark/capability"
import { MATRIX_CAPS } from "./adapters/matrix/capability"
import { ONEBOT_CAPS } from "./adapters/onebot/capability"
import { QQ_OFFICIAL_CAPS } from "./adapters/qq-official/capability"
import { SLACK_CAPS } from "./adapters/slack/capability"
import { TELEGRAM_CAPS } from "./adapters/telegram/capability"
import { WECHAT_OA_CAPS } from "./adapters/wechat-oa/capability"
import { WECHAT_PERSONAL_CAPS } from "./adapters/wechat-personal/capability"
import { WECOM_CAPS } from "./adapters/wecom/capability"

const PLATFORM_CAPABILITIES: Partial<Record<PlatformKind, readonly Capability[]>> = {
  telegram: TELEGRAM_CAPS,
  discord: DISCORD_CAPS,
  slack: SLACK_CAPS,
  lark: LARK_CAPS,
  onebot: ONEBOT_CAPS,
  dingtalk: DINGTALK_CAPS,
  wecom: WECOM_CAPS,
  "wechat-oa": WECHAT_OA_CAPS,
  "wechat-personal": WECHAT_PERSONAL_CAPS,
  "qq-official": QQ_OFFICIAL_CAPS,
  matrix: MATRIX_CAPS,
}

/**
 * Return the static capabilities a platform's built-in adapter declares.
 * Unknown / capability-less platforms return an empty array.
 */
export function getPlatformCapabilities(platform: PlatformKind): readonly Capability[] {
  return PLATFORM_CAPABILITIES[platform] ?? []
}
