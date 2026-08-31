"use client"

/**
 * The compact plugin list for the Discover tab's `plugins` category.
 *
 * Lists installed plugins with one Switch per row. Deliberately compact: this
 * is a browse surface, not the workspace. Full management (install, detail,
 * permissions, configuration, uninstall, batch actions) lives at `/plugins`,
 * which on a phone renders `components/mobile/plugins/plugins-mobile-body.tsx`
 * and is also what `/me/plugins` shows.
 *
 * The toggle goes through `setPluginEnabledForHost`, not through a Dexie write
 * plus an unconditional `plugin_set_enabled` enqueue. This panel used to do the
 * latter, which is right on a paired phone and wrong on a desktop or a
 * standalone browser, where the local manager owns the runtime.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { getDb } from "@/lib/db/schema"
import { setPluginEnabledForHost } from "@/lib/plugin/core/set-plugin-enabled-for-host"

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

  // Declared *before* the early return so the hook order is stable.
  const onToggle = useCallback(
    async (id: string, next: boolean) => {
      const result = await setPluginEnabledForHost(id, next)
      if (!result.ok) {
        toast.error(t("toggleFailed", { message: result.error ?? "" }))
      }
    },
    [t]
  )

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>
  }

  return (
    <ItemGroup className="gap-2" data-testid="plugins-panel">
      {rows.map((row) => {
        const name = row.name ?? row.id
        return (
          <Item
            key={row.id}
            variant="outline"
            size="sm"
            className="bg-card"
            data-testid={`plugin-row-${row.id}`}
          >
            <ItemContent>
              <ItemTitle className="flex items-center gap-2 text-sm">
                <span className="truncate">{name}</span>
                {row.version ? (
                  <Badge variant="outline" className="text-[10px]">
                    v{row.version}
                  </Badge>
                ) : null}
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={row.enabled ?? false}
                onCheckedChange={(next) => void onToggle(row.id, next)}
                aria-label={t("toggleAria", { name })}
                data-testid={`plugin-switch-${row.id}`}
              />
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
