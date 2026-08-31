"use client"

/**
 * One dispatcher for the eleven per-platform credential dialogs, plus the
 * schema-driven fallback for plugin-contributed kinds.
 *
 * The ladder existed twice, verbatim in shape and subtly different in detail:
 * `tabs/adapters-tab.tsx` opened it by `editing.kind` and passed `onCreated`
 * (the list has to select the row a create just made), while
 * `adapters/tabs/config-detail.tsx` opened it by `row.type` and did not. Adding
 * a twelfth platform meant editing both, and only one of them ever got the
 * plugin fallback, so a plugin adapter's detail page had an Edit button that
 * opened nothing at all.
 *
 * Every dialog stays MOUNTED and only the matching one is `open`, which is how
 * the ladder already worked. Unmounting the others would be cheaper but would
 * cut a dialog's close animation short, and the invariant that matters is the
 * one this preserves: exactly one dialog is open, so cross-platform form state
 * cannot leak between them.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import { PluginConnectorConfigDialog } from "./forms/plugin-connector-config"
import { TelegramConfigDialog } from "./forms/telegram-config"
import { LarkConfigDialog } from "./forms/lark-config"
import { DiscordConfigDialog } from "./forms/discord-config"
import { SlackConfigDialog } from "./forms/slack-config"
import { OneBotConfigDialog } from "./forms/onebot-config"
import { WeComConfigDialog } from "./forms/wecom-config"
import { WeChatPersonalConfigDialog } from "./forms/wechat-personal-config"
import { MatrixConfigDialog } from "./forms/matrix-config"
import { QQOfficialConfigDialog } from "./forms/qq-official-config"
import { WechatOaConfigDialog } from "./forms/wechat-oa-config"
import { DingTalkConfigDialog } from "./forms/dingtalk-config"

/** A platform with a bespoke, hand-written credential dialog. */
export type ConfigurableKind =
  | "telegram"
  | "lark"
  | "discord"
  | "slack"
  | "onebot"
  | "wecom"
  | "wechat-personal"
  | "matrix"
  | "qq-official"
  | "wechat-oa"
  | "dingtalk"

export const CONFIGURABLE_KINDS: readonly ConfigurableKind[] = [
  "telegram",
  "lark",
  "discord",
  "slack",
  "onebot",
  "wecom",
  "wechat-personal",
  "matrix",
  "qq-official",
  "wechat-oa",
  "dingtalk",
]

export function isConfigurableKind(kind: PlatformKind): kind is ConfigurableKind {
  return (CONFIGURABLE_KINDS as readonly PlatformKind[]).includes(kind)
}

type BespokeProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (id: string) => void
  row: AdapterInstanceRow | null
}

const BESPOKE: Record<ConfigurableKind, (props: BespokeProps) => React.ReactElement> = {
  telegram: TelegramConfigDialog,
  lark: LarkConfigDialog,
  discord: DiscordConfigDialog,
  slack: SlackConfigDialog,
  onebot: OneBotConfigDialog,
  wecom: WeComConfigDialog,
  "wechat-personal": WeChatPersonalConfigDialog,
  matrix: MatrixConfigDialog,
  "qq-official": QQOfficialConfigDialog,
  "wechat-oa": WechatOaConfigDialog,
  dingtalk: DingTalkConfigDialog,
} as unknown as Record<ConfigurableKind, (props: BespokeProps) => React.ReactElement>

export interface AdapterConfigDialogProps {
  /**
   * The platform whose dialog should be open, or `null` for none open.
   *
   * Typed `PlatformKind` because that is what both callers hold, but a plugin
   * contribution's kind is NOT in that union at runtime. That is the case the
   * fallback below exists for, so nothing here narrows on the union.
   */
  kind: PlatformKind | null | undefined
  /** The row being edited, or `null` when creating. */
  row: AdapterInstanceRow | null
  onOpenChange: (open: boolean) => void
  /**
   * Called with the new adapter's id after a create. Only the list needs it,
   * to select what was just made. The detail panel never creates, so it
   * leaves this unset rather than passing a no-op.
   */
  onCreated?: (id: string) => void
}

export function AdapterConfigDialog({
  kind,
  row,
  onOpenChange,
  onCreated,
}: AdapterConfigDialogProps) {
  // Anything without a bespoke dialog is a plugin contribution and gets the
  // schema-driven one. Deliberately NOT gated on `isPlatformKind`: a
  // contributed kind is not in that union by definition, and gating on it is
  // exactly how this dialog would go missing for the case it exists to serve.
  // Keyed so switching between two contributions cannot carry state, the same
  // rule the bespoke dialogs get for free by being separate components.
  const pluginKind = kind && !isConfigurableKind(kind) ? kind : null

  return (
    <>
      {pluginKind && (
        <PluginConnectorConfigDialog
          key={pluginKind}
          open
          kind={pluginKind}
          onOpenChange={onOpenChange}
          {...(onCreated ? { onCreated } : {})}
          row={row}
        />
      )}
      {CONFIGURABLE_KINDS.map((configurable) => {
        const Dialog = BESPOKE[configurable]
        return (
          <Dialog
            key={configurable}
            open={kind === configurable}
            onOpenChange={onOpenChange}
            {...(onCreated ? { onCreated } : {})}
            row={kind === configurable ? row : null}
          />
        )
      })}
    </>
  )
}
