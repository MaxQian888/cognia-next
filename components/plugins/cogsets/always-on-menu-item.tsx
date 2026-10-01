"use client"

import { useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PinIcon, PinOffIcon } from "lucide-react"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { getDb } from "@/lib/db/schema"
import { setPluginAlwaysOn } from "@/lib/plugin/cogset/actions"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import { COGSET_STATE_ID } from "@/types/plugin/plugin-cogset"

const NEVER_CHANGES = () => () => {}

/**
 * "Keep always on" for one plugin (ADR-0209): an always-on plugin stays on
 * whichever cogset runs. Host-only; on a mirrored client the item stays
 * visible and says where to change it.
 */
export function AlwaysOnMenuItem({
  pluginId,
  pluginName,
}: {
  pluginId: string
  pluginName: string
}) {
  const t = useTranslations("plugins.cogsets.alwaysOn")
  const state = useLiveQuery(() => getDb().pluginCogsetState.get(COGSET_STATE_ID), [])
  const mirrored = useSyncExternalStore(NEVER_CHANGES, isMirroredPluginClient, () => false)
  const on = state?.alwaysOn.includes(pluginId) ?? false
  const Icon = on ? PinOffIcon : PinIcon

  return (
    <DropdownMenuItem
      disabled={mirrored}
      className="items-start"
      data-testid="plugin-row-always-on"
      onClick={() =>
        void setPluginAlwaysOn(pluginId, !on).catch((error: unknown) =>
          toast.error(t("failed", { name: pluginName }), {
            description: error instanceof Error ? error.message : String(error),
          })
        )
      }
    >
      <Icon className="mt-0.5 mr-2 size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span>{on ? t("remove") : t("add")}</span>
        <span className="text-xs text-muted-foreground">
          {mirrored ? t("mirrored") : t("detail")}
        </span>
      </span>
    </DropdownMenuItem>
  )
}
