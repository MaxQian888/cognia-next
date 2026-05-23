"use client"

// Shared action menu used by both PluginCard (card grid view) and the new
// PluginLibraryRow (compact list view). Extracted from the previous inline
// DropdownMenu in plugin-card.tsx so the two surfaces can't drift on which
// actions are available, the order, the icons, or the i18n keys.
//
// Action set: open details / configure / review permissions / rollback /
// toggle enabled / uninstall. Rollback is optional — pass an `onRollback`
// callback only when the plugin actually has a previous version available.

import { useTranslations } from "next-intl"
import {
  MoreHorizontalIcon,
  PowerIcon,
  RotateCcwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import type { PluginRow } from "@/lib/db/plugin-types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface PluginRowActionsMenuProps {
  plugin: PluginRow
  onOpen: (id: string) => void
  onConfigure: (id: string) => void
  onReviewPermissions: (id: string) => void
  onToggleEnabled: (plugin: PluginRow) => void
  onUninstall: (plugin: PluginRow) => void
  /** Pass to expose the "Rollback" item; omit to hide it. */
  onRollback?: (id: string) => void
  /**
   * Size of the trigger button. The grid card uses `size-7` for visual
   * balance; the compact list row uses `size-6` to keep rows shorter.
   */
  triggerClassName?: string
}

export function PluginRowActionsMenu({
  plugin,
  onOpen,
  onConfigure,
  onReviewPermissions,
  onToggleEnabled,
  onUninstall,
  onRollback,
  triggerClassName,
}: PluginRowActionsMenuProps) {
  const t = useTranslations("plugins.card")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={triggerClassName ?? "size-7 shrink-0"}
          aria-label={t("actionsMenuAria", { name: plugin.name })}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onOpen(plugin.id)}>{t("openDetails")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onConfigure(plugin.id)}>
          <SettingsIcon className="mr-2 size-3.5" />
          {t("configure")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onReviewPermissions(plugin.id)}>
          <ShieldCheckIcon className="mr-2 size-3.5" />
          {t("reviewPermissions")}
        </DropdownMenuItem>
        {onRollback && (
          <DropdownMenuItem onClick={() => onRollback(plugin.id)}>
            <RotateCcwIcon className="mr-2 size-3.5" />
            {t("rollback")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onToggleEnabled(plugin)}>
          <PowerIcon className="mr-2 size-3.5" />
          {plugin.enabled ? t("disable") : t("enable")}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onUninstall(plugin)}>
          <Trash2Icon className="mr-2 size-3.5" />
          {t("uninstall")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
