"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, CircleIcon, InboxIcon, PlusIcon, Settings2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { cn } from "@/lib/utils"
import { TelegramConfigDialog } from "../forms/telegram-config"
import { LarkConfigDialog } from "../forms/lark-config"
import { DiscordConfigDialog } from "../forms/discord-config"
import { SlackConfigDialog } from "../forms/slack-config"
import { OneBotConfigDialog } from "../forms/onebot-config"
import { AdapterDetailPanel } from "../adapters/adapter-detail-panel"
import { useSelectedAdapter } from "../adapters/use-selected-adapter"

type AdapterMenuEntry = {
  kind: PlatformKind
  label: string
  available: boolean
}

// Platform kinds whose configuration dialog is wired into this tab.
// All five platforms ship with a dialog under `../forms/`; the dispatcher
// below picks the right one by `row.type`.
type ConfigurableKind = "telegram" | "lark" | "discord" | "slack" | "onebot"

const CONFIGURABLE_KINDS: ConfigurableKind[] = ["telegram", "lark", "discord", "slack", "onebot"]

const ADAPTER_MENU: AdapterMenuEntry[] = [
  { kind: "telegram", label: "Telegram", available: true },
  { kind: "lark", label: "Lark / Feishu", available: true },
  { kind: "discord", label: "Discord", available: true },
  { kind: "slack", label: "Slack", available: true },
  { kind: "onebot", label: "OneBot v11 (QQ)", available: true },
]

function isConfigurableKind(kind: PlatformKind): kind is ConfigurableKind {
  return (CONFIGURABLE_KINDS as PlatformKind[]).includes(kind)
}

function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <CircleIcon
      className={cn("h-2.5 w-2.5 shrink-0 fill-current", {
        "text-emerald-500": enabled,
        "text-muted-foreground": !enabled,
      })}
    />
  )
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
  const { selectedAdapterId, setSelectedAdapterId } = useSelectedAdapter()

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  // Per-adapter pending+sending count for the sidebar badge. Reads the
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

  const onToggleEnabled = async (row: AdapterInstanceRow) => {
    await updateAdapterInstance(row.id, { enabled: !row.enabled })
  }

  const onConfigure = (row: AdapterInstanceRow) => {
    if (isConfigurableKind(row.type)) {
      setEditing({ kind: row.type, row })
    }
  }

  const onAddAdapter = (kind: PlatformKind) => {
    if (isConfigurableKind(kind)) {
      setEditing({ kind, row: null })
    }
  }

  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null)
  }

  return (
    <div className="space-y-4">
      {/* Add adapter dropdown */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("manageHint")}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <PlusIcon className="mr-2 h-3.5 w-3.5" />
              {t("addAdapter")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ADAPTER_MENU.map((entry) => (
              <DropdownMenuItem
                key={entry.kind}
                disabled={!entry.available}
                onClick={entry.available ? () => onAddAdapter(entry.kind) : undefined}
              >
                {entry.label}
                {!entry.available && (
                  <span className="ml-2 text-xs text-muted-foreground">{t("comingSoon")}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Adapter list + detail panel — sidebar (240px) on md+ screens,
       * stacked single column below md. Clicking a row sets the
       * `?adapter=<id>` URL param; the detail panel reads it. */}
      {!adapters || adapters.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <BotIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("noAdaptersTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("noAdaptersHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div
          className="flex flex-col gap-4 md:grid md:grid-cols-[260px_1fr]"
          data-testid="adapters-shell"
        >
          <div className="space-y-2" data-testid="adapters-sidebar">
            {adapters.map((row) => {
              const isSelected = row.id === selectedAdapterId
              const pendingCount = pendingByAdapter.get(row.id) ?? 0
              return (
                <Card
                  key={row.id}
                  className={cn(
                    "cursor-pointer transition-colors",
                    isSelected ? "border-primary bg-primary/5" : "hover:border-muted-foreground/40"
                  )}
                  onClick={() => setSelectedAdapterId(row.id)}
                  role="button"
                  aria-pressed={isSelected}
                  data-testid={`adapter-card-${row.id}`}
                >
                  <CardHeader className="pb-2 pt-3">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <StatusDot enabled={row.enabled} />
                      <span className="flex-1 truncate">{row.displayName}</span>
                      {pendingCount > 0 && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 gap-1 text-xs"
                          aria-label={t("pendingBadgeAria", { count: pendingCount })}
                          data-testid={`adapter-pending-${row.id}`}
                        >
                          <InboxIcon className="h-3 w-3" aria-hidden />
                          {pendingCount}
                        </Badge>
                      )}
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {row.type}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-3">
                    <div
                      className="flex items-center justify-between gap-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`adapter-enabled-${row.id}`}
                          checked={row.enabled}
                          onCheckedChange={() => onToggleEnabled(row)}
                          aria-label={
                            row.enabled
                              ? t("disableAria", { name: row.displayName })
                              : t("enableAria", { name: row.displayName })
                          }
                        />
                        <label
                          htmlFor={`adapter-enabled-${row.id}`}
                          className="text-xs text-muted-foreground cursor-pointer"
                        >
                          {row.enabled ? t("enabled") : t("disabled")}
                        </label>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onConfigure(row)}
                        aria-label={t("configureAria", { name: row.displayName })}
                      >
                        <Settings2Icon className="mr-2 h-3.5 w-3.5" />
                        {t("configure")}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

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
