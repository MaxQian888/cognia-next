"use client"

/**
 * Mobile plugins toggle panel (Wave 2.6).
 *
 * Lists installed plugins and exposes a single Switch per row that flips
 * `enabled` via the new `plugin_set_enabled` outbound RPC. Reads from the
 * `plugins` Dexie table warmed by `sync_pull("plugins")`.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"

interface PluginRow {
  id: string
  name?: string
  version?: string
  enabled?: boolean
}

export function PluginsPanel() {
  const t = useTranslations("mobile.plugins")
  const rows =
    useLiveQuery<PluginRow[]>(() => getDb().plugins.toArray() as Promise<PluginRow[]>, []) ?? []

  // useCallback isolates the impure `Date.now()` and Dexie write from
  // the render path, which the React compiler otherwise flags. Declared
  // *before* the early return so the hook order is stable.
  const onToggle = useCallback(
    async (id: string, name: string, next: boolean) => {
      try {
        await getDb().plugins.update(id, { enabled: next, updatedAt: Date.now() })
        await enqueue({
          command: "plugin_set_enabled",
          payload: { id, enabled: next },
          label: t("queueLabel", { name, state: next ? t("enabled") : t("disabled") }),
        })
      } catch (err) {
        toast.error(
          t("toggleFailed", { message: err instanceof Error ? err.message : String(err) })
        )
      }
    },
    [t]
  )

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="plugins-panel">
      {rows.map((row) => {
        const name = row.name ?? row.id
        return (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 rounded-md border bg-card p-3"
            data-testid={`plugin-row-${row.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{name}</span>
                {row.version ? (
                  <Badge variant="outline" className="text-[10px]">
                    v{row.version}
                  </Badge>
                ) : null}
              </div>
            </div>
            <Switch
              checked={row.enabled ?? false}
              onCheckedChange={(next) => void onToggle(row.id, name, next)}
              aria-label={t("toggleAria", { name })}
              data-testid={`plugin-switch-${row.id}`}
            />
          </li>
        )
      })}
    </ul>
  )
}
