"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { TelegramConfigDialog } from "../forms/telegram-config"
import { LarkConfigDialog } from "../forms/lark-config"
import { DiscordConfigDialog } from "../forms/discord-config"
import { SlackConfigDialog } from "../forms/slack-config"
import { OneBotConfigDialog } from "../forms/onebot-config"
import { WeComConfigDialog } from "../forms/wecom-config"
import { WeChatPersonalConfigDialog } from "../forms/wechat-personal-config"
import { MatrixConfigDialog } from "../forms/matrix-config"
import { QQOfficialConfigDialog } from "../forms/qq-official-config"
import { WechatOaConfigDialog } from "../forms/wechat-oa-config"
import { AdapterDetailPanel } from "../adapters/adapter-detail-panel"
import { AdapterListRow } from "../adapters/adapter-list-row"
import { AddConnectorGrid } from "../adapters/add-connector-grid"
import { useSelectedAdapter } from "../adapters/use-selected-adapter"

// Platform kinds whose configuration dialog is wired into this tab. Each ships
// with a dialog under `../forms/`; the dispatcher below picks the right one by
// `row.type`. This list also drives the AddConnectorGrid picker.
type ConfigurableKind =
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

const CONFIGURABLE_KINDS: ConfigurableKind[] = [
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
]

function isConfigurableKind(kind: PlatformKind): kind is ConfigurableKind {
  return (CONFIGURABLE_KINDS as PlatformKind[]).includes(kind)
}

type EditingDialog = {
  /** Which config dialog is currently visible; null = none. */
  kind: ConfigurableKind
  /** Pre-fill row for edit; null = adding a new instance. */
  row: AdapterInstanceRow | null
}

export function AdaptersTab() {
  const t = useTranslations("settings.connections.adapters")
  const [editing, setEditing] = useState<EditingDialog | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const { selectedAdapterId } = useSelectedAdapter()

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  // Per-adapter pending+sending count for the row badge. Reads the
  // outboundQueue directly so the count is always live (vs. waiting up to
  // 30 s for the next heartbeat to refresh `pendingOutboundCount`).
  const outboundJobs = useLiveQuery<OutboundJobRow[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : getDb().outboundQueue.toArray()),
    []
  )
  const pendingByAdapter = useMemo(() => {
    const counts = new Map<string, number>()
    for (const job of outboundJobs ?? []) {
      if (job.status === "pending" || job.status === "sending") {
        counts.set(job.adapterId, (counts.get(job.adapterId) ?? 0) + 1)
      }
    }
    return counts
  }, [outboundJobs])

  // Configured-instance count per platform kind, for the picker badges.
  const configuredCounts = useMemo(() => {
    const counts = new Map<PlatformKind, number>()
    for (const row of adapters ?? []) {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1)
    }
    return counts
  }, [adapters])

  const onConfigure = (row: AdapterInstanceRow) => {
    if (isConfigurableKind(row.type)) {
      setEditing({ kind: row.type, row })
    }
  }

  const onPickPlatform = (kind: PlatformKind) => {
    if (isConfigurableKind(kind)) {
      setAddOpen(false)
      setEditing({ kind, row: null })
    }
  }

  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null)
  }

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setAddOpen(true)}
      data-testid="add-adapter-button"
    >
      <PlusIcon className="mr-2 h-3.5 w-3.5" />
      {t("addAdapter")}
    </Button>
  )

  const isEmpty = !adapters || adapters.length === 0

  return (
    <div className="space-y-4">
      {isEmpty ? (
        <Card>
          <CardContent className="py-2">
            <SettingsEmptyState
              icon={<BotIcon className="size-6" />}
              title={t("noAdaptersTitle")}
              description={t("noAdaptersHint")}
              action={addButton}
            />
          </CardContent>
        </Card>
      ) : (
        // Adapter list (left) + detail panel (right) — sidebar (260px) on
        // md+ screens, stacked single column below md. Selecting a row sets
        // the `?adapter=<id>` URL param; the detail panel reads it.
        <div
          className="flex flex-col gap-4 md:grid md:grid-cols-[260px_1fr]"
          data-testid="adapters-shell"
        >
          <Card data-testid="adapters-sidebar">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm">{t("listTitle")}</Label>
                {addButton}
              </div>
              <ul className="space-y-1.5">
                {adapters.map((row) => (
                  <AdapterListRow
                    key={row.id}
                    row={row}
                    pendingCount={pendingByAdapter.get(row.id) ?? 0}
                    onConfigure={onConfigure}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>

          <div className="min-w-0" data-testid="adapters-detail">
            {selectedAdapterId ? (
              <AdapterDetailPanel adapterId={selectedAdapterId} />
            ) : (
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  {t("detail.noSelection")}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Platform picker — brand-card grid → opens the matching dialog. */}
      <AddConnectorGrid
        open={addOpen}
        onOpenChange={setAddOpen}
        kinds={CONFIGURABLE_KINDS}
        configuredCounts={configuredCounts}
        onPick={onPickPlatform}
      />

      {/* Per-platform configuration dialogs. Only the dialog matching the
       * active `editing.kind` is open at any time so cross-platform state
       * cannot leak between forms. Mounting them all lets the dispatcher
       * stay a pure switch on `editing.kind`. */}
      <TelegramConfigDialog
        open={editing?.kind === "telegram"}
        onOpenChange={closeDialog}
        row={editing?.kind === "telegram" ? editing.row : null}
      />
      <LarkConfigDialog
        open={editing?.kind === "lark"}
        onOpenChange={closeDialog}
        row={editing?.kind === "lark" ? editing.row : null}
      />
      <DiscordConfigDialog
        open={editing?.kind === "discord"}
        onOpenChange={closeDialog}
        row={editing?.kind === "discord" ? editing.row : null}
      />
      <SlackConfigDialog
        open={editing?.kind === "slack"}
        onOpenChange={closeDialog}
        row={editing?.kind === "slack" ? editing.row : null}
      />
      <OneBotConfigDialog
        open={editing?.kind === "onebot"}
        onOpenChange={closeDialog}
        row={editing?.kind === "onebot" ? editing.row : null}
      />
      <WeComConfigDialog
        open={editing?.kind === "wecom"}
        onOpenChange={closeDialog}
        row={editing?.kind === "wecom" ? editing.row : null}
      />
      <WeChatPersonalConfigDialog
        open={editing?.kind === "wechat-personal"}
        onOpenChange={closeDialog}
        row={editing?.kind === "wechat-personal" ? editing.row : null}
      />
      <MatrixConfigDialog
        open={editing?.kind === "matrix"}
        onOpenChange={closeDialog}
        row={editing?.kind === "matrix" ? editing.row : null}
      />
      <QQOfficialConfigDialog
        open={editing?.kind === "qq-official"}
        onOpenChange={closeDialog}
        row={editing?.kind === "qq-official" ? editing.row : null}
      />
      <WechatOaConfigDialog
        open={editing?.kind === "wechat-oa"}
        onOpenChange={closeDialog}
        row={editing?.kind === "wechat-oa" ? editing.row : null}
      />
    </div>
  )
}
