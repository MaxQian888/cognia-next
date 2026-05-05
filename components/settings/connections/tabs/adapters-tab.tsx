"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, CircleIcon, PlusIcon, Settings2Icon } from "lucide-react"
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
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { cn } from "@/lib/utils"
import { TelegramConfigDialog } from "../forms/telegram-config"

type AdapterMenuEntry = {
  kind: PlatformKind
  label: string
  available: boolean
}

const ADAPTER_MENU: AdapterMenuEntry[] = [
  { kind: "telegram", label: "Telegram", available: true },
  { kind: "discord", label: "Discord", available: false },
  { kind: "slack", label: "Slack", available: false },
  { kind: "lark", label: "Lark / Feishu", available: false },
  { kind: "onebot", label: "OneBot v11", available: false },
]

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

export function AdaptersTab() {
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<AdapterInstanceRow | null>(null)

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  const onToggleEnabled = async (row: AdapterInstanceRow) => {
    await updateAdapterInstance(row.id, { enabled: !row.enabled })
  }

  const onConfigure = (row: AdapterInstanceRow) => {
    if (row.type === "telegram") {
      setEditingRow(row)
      setTelegramDialogOpen(true)
    }
  }

  const onAddTelegram = () => {
    setEditingRow(null)
    setTelegramDialogOpen(true)
  }

  return (
    <div className="space-y-4">
      {/* Add adapter dropdown */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Manage your platform adapter instances.</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <PlusIcon className="mr-2 h-3.5 w-3.5" />
              Add adapter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ADAPTER_MENU.map((entry) => (
              <DropdownMenuItem
                key={entry.kind}
                disabled={!entry.available}
                onClick={entry.available && entry.kind === "telegram" ? onAddTelegram : undefined}
              >
                {entry.label}
                {!entry.available && (
                  <span className="ml-2 text-xs text-muted-foreground">Coming soon</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Adapter instance list */}
      {!adapters || adapters.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <BotIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No adapters configured yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Click &ldquo;Add adapter&rdquo; to add your first platform connection.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {adapters.map((row) => (
            <Card key={row.id}>
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <StatusDot enabled={row.enabled} />
                  <span className="flex-1 truncate">{row.displayName}</span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {row.type}
                  </Badge>
                  <Badge variant="secondary" className="shrink-0 text-xs">
                    {row.defaultMode}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`adapter-enabled-${row.id}`}
                      checked={row.enabled}
                      onCheckedChange={() => onToggleEnabled(row)}
                      aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.displayName}`}
                    />
                    <label
                      htmlFor={`adapter-enabled-${row.id}`}
                      className="text-xs text-muted-foreground cursor-pointer"
                    >
                      {row.enabled ? "Enabled" : "Disabled"}
                    </label>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onConfigure(row)}
                    aria-label={`Configure ${row.displayName}`}
                  >
                    <Settings2Icon className="mr-2 h-3.5 w-3.5" />
                    Configure
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Telegram form dialog */}
      <TelegramConfigDialog
        open={telegramDialogOpen}
        onOpenChange={setTelegramDialogOpen}
        row={editingRow}
      />
    </div>
  )
}
