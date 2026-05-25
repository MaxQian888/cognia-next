"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { TelegramConfigDialog } from "../forms/telegram-config"
import { LarkConfigDialog } from "../forms/lark-config"
import { DiscordConfigDialog } from "../forms/discord-config"
import { SlackConfigDialog } from "../forms/slack-config"
import { OneBotConfigDialog } from "../forms/onebot-config"
import { AdapterDetailPanel } from "../adapters/adapter-detail-panel"
import { AdapterListRow } from "../adapters/adapter-list-row"
import { useSelectedAdapter } from "../adapters/use-selected-adapter"

// Platform kinds whose configuration dialog is wired into this tab.
// All five platforms ship with a dialog under `../forms/`; the dispatcher
// below picks the right one by `row.type`.
type ConfigurableKind = "telegram" | "lark" | "discord" | "slack" | "onebot"

const CONFIGURABLE_KINDS: ConfigurableKind[] = ["telegram", "lark", "discord", "slack", "onebot"]

// Display order of the "Add adapter" menu. Labels resolve from
// `platforms.<kind>` so they stay i18n-wired and shared with the row.
const ADAPTER_MENU: ConfigurableKind[] = ["telegram", "lark", "discord", "slack", "onebot"]

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

  const onConfigure = (row: AdapterInstanceRow) => {
    if (isConfigurableKind(row.type)) {
      setEditing({ kind: row.type, row })
    }
  }

  const onAddAdapter = (kind: ConfigurableKind) => {
    setEditing({ kind, row: null })
  }

  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null)
  }

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon className="mr-2 h-3.5 w-3.5" />
          {t("addAdapter")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ADAPTER_MENU.map((kind) => (
          <DropdownMenuItem key={kind} onClick={() => onAddAdapter(kind)}>
            {t(`platforms.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
              action={addMenu}
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
                {addMenu}
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

      {/* Per-platform configuration dialogs. Only the dialog matching the
       * active `editing.kind` is open at any time so cross-platform state
       * cannot leak between forms. Mounting all five lets the dispatcher
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
    </div>
  )
}
