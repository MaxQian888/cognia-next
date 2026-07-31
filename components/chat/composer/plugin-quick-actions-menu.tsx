"use client"

/**
 * Composer surface for plugin quick actions — a single dropdown trigger
 * listing every registered action whose `surfaces` include `"composer"`.
 * Renders nothing when no plugin contributed actions, so the toolbar pays
 * zero cost in the common case.
 *
 * Dispatch goes through `runQuickAction` (inline handler → command id →
 * slash line), the same rail the palette and tray use.
 */

import { ZapIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePluginQuickActions } from "@/hooks/plugins/use-plugin-quick-actions"
import { runQuickAction } from "@/lib/plugin/registries/quick-action-registry"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { loggers } from "@cognia/logging"

export function PluginQuickActionsMenu({ disabled }: { disabled?: boolean }) {
  const t = useTranslations("chat.composer.toolbar")
  const pluginT = useTranslations()
  const actions = usePluginQuickActions("composer")
  if (actions.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("quickActions")}
          disabled={disabled}
          className="size-7"
        >
          <ZapIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.fullId}
            onSelect={() => {
              runQuickAction(action).catch((err) => {
                loggers.plugin.warn("quick action dispatch failed", {
                  id: action.fullId,
                  error: String(err),
                })
              })
            }}
          >
            <PluginSurface
              pluginId={action.pluginId}
              surfaceId={`quick-action:${action.fullId}`}
              formFactor="icon"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate">
                  {resolvePluginLabel(
                    pluginT as never,
                    action.pluginId,
                    action.labelKey,
                    action.title
                  )}
                </span>
                {action.description ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {action.description}
                  </span>
                ) : null}
              </div>
            </PluginSurface>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
