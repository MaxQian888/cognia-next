"use client"

// Shared action menu used by both PluginCard (card grid view) and the new
// PluginLibraryRow (compact list view). Extracted from the previous inline
// DropdownMenu in plugin-card.tsx so the two surfaces can't drift on which
// actions are available, the order, the icons, or the i18n keys.
//
// Action set: open details / configure / review permissions / rollback /
// toggle enabled / uninstall.
//
// The menu also owns the three "can this action do anything here" gates, so
// every surface that renders it disables the same way and SAYS why inline (a
// disabled menu item with a hover tooltip would be mute on a phone):
//   - Enable: `usePluginEnableGate` (runtime-incompatible → disabled + reason).
//   - Uninstall: `pluginUninstallBlockReason` (mirrored client / built-in).
//   - Rollback: offered only when `usePluginRollbackAvailable` says a backup of
//     another version exists on the desktop shell AND the caller wired it.

import { useTranslations } from "next-intl"
import { useLocalizedPluginText } from "@/hooks/plugins/use-localized-plugin-text"
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
  DropdownMenuItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePluginEnableGate } from "@/hooks/plugins/use-plugin-enable-gate"
import { usePluginRollbackAvailable } from "@/hooks/plugins/use-plugin-rollback-availability"
import { pluginUninstallBlockReason } from "@/hooks/plugins/use-plugin-uninstall"
import { cn } from "@/lib/utils"

export interface PluginRowActionsMenuProps {
  plugin: PluginRow
  onOpen: (id: string) => void
  onConfigure: (id: string) => void
  onReviewPermissions: (id: string) => void
  onToggleEnabled: (plugin: PluginRow) => void
  onUninstall: (plugin: PluginRow) => void
  /**
   * Pass to allow the "Rollback" item. It is still shown only when a rollback
   * is actually possible for this plugin on this host.
   */
  onRollback?: (id: string) => void
  /**
   * Size of the trigger button. The grid card uses `size-7` for visual
   * balance; the compact list row uses `size-6` to keep rows shorter. Both
   * grow to 36px on a coarse pointer.
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
  const tLifecycle = useTranslations("plugins.lifecycleFeedback")
  const { name: displayName } = useLocalizedPluginText(plugin)
  const gate = usePluginEnableGate(plugin)
  const rollbackAvailable = usePluginRollbackAvailable(plugin.id, plugin.version)
  const uninstallBlocked = pluginUninstallBlockReason(plugin)
  // Disabling stays possible for an incompatible plugin: turning OFF a plugin
  // that cannot run is always safe and is how a user clears a stale "enabled".
  const enableBlocked = !plugin.enabled && gate.blocked

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(triggerClassName ?? "size-7 shrink-0", "pointer-coarse:size-9")}
          aria-label={t("actionsMenuAria", { name: displayName })}
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        <DropdownMenuItem onClick={() => onOpen(plugin.id)}>{t("openDetails")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onConfigure(plugin.id)}>
          <SettingsIcon className="mr-2 size-3.5" />
          {t("configure")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onReviewPermissions(plugin.id)}>
          <ShieldCheckIcon className="mr-2 size-3.5" />
          {t("reviewPermissions")}
        </DropdownMenuItem>
        {onRollback && rollbackAvailable && (
          <DropdownMenuItem onClick={() => onRollback(plugin.id)}>
            <RotateCcwIcon className="mr-2 size-3.5" />
            {t("rollback")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={enableBlocked}
          onClick={() => onToggleEnabled(plugin)}
          className="items-start"
          data-testid="plugin-row-toggle-enabled"
        >
          <PowerIcon className="mt-0.5 mr-2 size-3.5 shrink-0" />
          <MenuItemLabel
            label={plugin.enabled ? t("disable") : t("enable")}
            detail={
              enableBlocked ? gate.reason : gate.runsOnDesktop ? tLifecycle("runsOnDesktop") : null
            }
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={uninstallBlocked !== null}
          onClick={() => onUninstall(plugin)}
          className="items-start"
          data-testid="plugin-row-uninstall"
        >
          <Trash2Icon className="mt-0.5 mr-2 size-3.5 shrink-0" />
          <MenuItemLabel
            label={t("uninstall")}
            detail={uninstallBlocked ? tLifecycle(`uninstallBlocked.${uninstallBlocked}`) : null}
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The reason sits under the label, in the item itself: a disabled item cannot
 * be hovered for a tooltip on a phone, and focus skips disabled items too.
 */
function MenuItemLabel({ label, detail }: { label: string; detail: string | null }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      {detail ? (
        <span className="text-[11px] leading-snug whitespace-normal text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </span>
  )
}
