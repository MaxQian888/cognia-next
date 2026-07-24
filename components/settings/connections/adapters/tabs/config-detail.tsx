"use client"

/**
 * Per-adapter Config detail tab (im-refactored-crayon).
 *
 * Mounted inside `AdapterDetailPanel`. The body is per-platform:
 *
 *   - Lark: composes whoami panel + at-strategy radio + chat whitelist
 *     editor + an Edit button that opens the existing LarkConfigDialog
 *     so credentials (App ID / Secret / Verification / Encrypt key) can
 *     still be rotated.
 *   - Other platforms: a single "Edit credentials" button that opens the
 *     platform's existing config dialog. Lit up when those dialogs are
 *     wired into the Adapters tab.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Settings2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LarkConfigDialog } from "../../forms/lark-config"
import { TelegramConfigDialog } from "../../forms/telegram-config"
import { DiscordConfigDialog } from "../../forms/discord-config"
import { SlackConfigDialog } from "../../forms/slack-config"
import { MatrixConfigDialog } from "../../forms/matrix-config"
import { OneBotConfigDialog } from "../../forms/onebot-config"
import { DingTalkConfigDialog } from "../../forms/dingtalk-config"
import { WeComConfigDialog } from "../../forms/wecom-config"
import { WechatOaConfigDialog } from "../../forms/wechat-oa-config"
import { WeChatPersonalConfigDialog } from "../../forms/wechat-personal-config"
import { QQOfficialConfigDialog } from "../../forms/qq-official-config"
import { LarkWhoamiPanel } from "../../forms/lark/lark-whoami-panel"
import { AdapterWhoamiPanel } from "../../forms/shared/adapter-whoami-panel"
import { SendTestMessageSection } from "../../forms/shared/send-test-message-section"
// LarkAtStrategy + LarkWhitelistEditor are platform-neutral in behaviour
// (they read/write `atResponseStrategy` + `chatAllowlist` / `chatBlocklist`
// on the adapter row, which are bus-level concepts, not Lark-specific).
// Re-used for every platform in the detail panel; the "Lark" prefix is a
// historical naming artefact left in place to avoid file churn.
import { LarkAtStrategy } from "../../forms/lark/lark-at-strategy"
import { LarkWhitelistEditor } from "../../forms/lark/lark-whitelist-editor"
import { LarkEntrySurfaces } from "../../forms/lark/lark-entry-surfaces"
import { LarkPrincipals } from "../../forms/lark/lark-principals"
import { RunOperators } from "../../forms/run-operators"
import { HelpAndWelcome } from "../../forms/help-and-welcome"
import { ControlCommands } from "../../forms/control-commands"
import { AiBindingDefaults } from "../../forms/ai-binding-defaults"
import { DispatchRules } from "../../forms/dispatch-rules"
import { OutboundTuning } from "../../forms/outbound-tuning"
import { UsagePresence } from "../../forms/usage-presence"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getAdapterTransportLabelKey } from "../platform-meta"
import { ConnectedScopesCard } from "./connected-scopes-card"

export interface ConfigDetailProps {
  row: AdapterInstanceRow
}

export function ConfigDetail({ row }: ConfigDetailProps) {
  const t = useTranslations("settings.connections.adapters.detail")
  const tAdapters = useTranslations("settings.connections.adapters")
  const [editing, setEditing] = useState(false)
  const transportLabelKey = getAdapterTransportLabelKey(row.type, row.transportMode)
  const transportLabel = transportLabelKey ? tAdapters(transportLabelKey) : row.transportMode

  return (
    <div className="space-y-4" data-testid="config-detail">
      <Card>
        <CardHeader className="pb-2 pt-3">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span>{row.displayName}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              data-testid="config-detail-edit"
            >
              <Settings2Icon className="mr-1.5 h-3.5 w-3.5" />
              {t("editCredentials")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          <div>
            <span>{t("fieldType")}: </span>
            <span className="font-mono">{row.type}</span>
          </div>
          <div>
            <span>{t("fieldTransport")}: </span>
            <span className="font-mono" title={row.transportMode}>
              {transportLabel}
            </span>
          </div>
          <div>
            <span>{t("fieldMode")}: </span>
            <span className="font-mono">{row.defaultMode}</span>
          </div>
          {row.publicUrl && (
            <div>
              <span>{t("fieldPublicUrl")}: </span>
              <span className="font-mono break-all">{row.publicUrl}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bot identity panel — Lark gets its richer panel that surfaces
       * tenant + scopes; every other platform gets the generic panel
       * that branches on `row.type` to call the right probe. */}
      {row.type === "lark" ? (
        <LarkWhoamiPanel adapterId={row.id} />
      ) : (
        <AdapterWhoamiPanel adapterId={row.id} platform={row.type} />
      )}

      {/* Read-only granted OAuth scopes (persisted by the platform OAuth
       * handlers). Renders only for adapters that recorded scopes. */}
      <ConnectedScopesCard row={row} />

      {/* Mention strategy + chat allow/blocklist — applies to every
       * platform that distinguishes private / group / channel contexts.
       * The components were originally written for Lark but the body is
       * platform-neutral. */}
      <LarkAtStrategy adapterId={row.id} />
      <LarkWhitelistEditor adapterId={row.id} />

      {/* Lark-only: web entry base, entry feature-flag overrides, callback
       * authorization mode, and the Chat Tab / group-menu surface list
       * (plan 2026-07-24 dual-entry epic). */}
      {row.type === "lark" && <LarkEntrySurfaces adapterId={row.id} />}

      {/* Lark-only: the identity registry admin loop (tenant admission, bind
       * request approval, principal enable/disable). The registry fails
       * closed, so this card is what makes `larkPrincipalRegistry` operable
       * at all. */}
      {row.type === "lark" && <LarkPrincipals adapterId={row.id} />}

      {/* Who may act on a run they did not start. Read by the callback
       * authorization guard, the run-control gate, and follow-up control on
       * every platform, so it mounts unconditionally. */}
      <RunOperators adapterId={row.id} />

      {/* Cross-provider help / welcome card settings. Self-managing, so a
       * single mount here covers every platform. */}
      <HelpAndWelcome adapterId={row.id} />

      {/* Token-usage presence (badge / pinned card). Self-managing; the
       * badge tier auto-hides on platforms without `presence.status`. */}
      <UsagePresence adapterId={row.id} />

      {/* In-chat control-command permission gate (control-plane). Self-
       * managing; one mount covers every platform. */}
      <ControlCommands adapterId={row.id} />

      {/* Instance-level AI binding defaults (persona / team / model /
       * reasoning — W1 multi-bot). Self-managing; one mount covers every
       * platform, so the 11 per-platform create dialogs stay untouched. */}
      <AiBindingDefaults adapterId={row.id} />

      {/* Inbound dispatch rules (条件规则表 — W3 multi-bot). Declarative
       * keyword/regex/sender/channel → character|team|workflow routing;
       * self-managing, one mount covers every platform. */}
      <DispatchRules adapterId={row.id} />

      {/* Per-bot outbound throttle/breaker tuning + circuit-open failover
       * targets (multi-bot). Self-managing, one mount covers every platform. */}
      <OutboundTuning adapterId={row.id} />

      {/* End-to-end verify: send a synthetic message through the same
       * bus path the runner uses. Lives here (not in the create dialog)
       * because the adapter must be registered with the running bus —
       * which only happens after the row is enabled. Reuses
       * `getBus().sendOutbound` for full-pipeline coverage. */}
      <SendTestMessageSection adapterId={row.id} platform={row.type} />

      {/* Edit-credentials dialogs — only the dialog matching the row's
       * platform mounts open at any time. */}
      <LarkConfigDialog
        open={editing && row.type === "lark"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "lark" ? row : null}
      />
      <TelegramConfigDialog
        open={editing && row.type === "telegram"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "telegram" ? row : null}
      />
      <DiscordConfigDialog
        open={editing && row.type === "discord"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "discord" ? row : null}
      />
      <SlackConfigDialog
        open={editing && row.type === "slack"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "slack" ? row : null}
      />
      <MatrixConfigDialog
        open={editing && row.type === "matrix"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "matrix" ? row : null}
      />
      <OneBotConfigDialog
        open={editing && row.type === "onebot"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "onebot" ? row : null}
      />
      <DingTalkConfigDialog
        open={editing && row.type === "dingtalk"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "dingtalk" ? row : null}
      />
      <WeComConfigDialog
        open={editing && row.type === "wecom"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "wecom" ? row : null}
      />
      <WechatOaConfigDialog
        open={editing && row.type === "wechat-oa"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "wechat-oa" ? row : null}
      />
      <WeChatPersonalConfigDialog
        open={editing && row.type === "wechat-personal"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "wechat-personal" ? row : null}
      />
      <QQOfficialConfigDialog
        open={editing && row.type === "qq-official"}
        onOpenChange={(open) => {
          if (!open) setEditing(false)
        }}
        row={row.type === "qq-official" ? row : null}
      />
    </div>
  )
}
