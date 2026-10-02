"use client"

/**
 * Managed IDE Dev Mode permission simulation: decide one permission for one
 * plugin for this session (`lib/plugin/ide/dev-mode`). The broker's
 * authorization path consults it only while Dev Mode is on; nothing here is
 * saved, and every plugin with a simulation in force carries a badge.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { setSimulatedPermission, type SimulatedDecision } from "@/lib/plugin/ide/dev-mode"
import { normalizeIdeManifest } from "@/lib/plugin/ide/manifest"
import type { Plugin, PluginPermission } from "@/types/plugin"

const DECISIONS: SimulatedDecision[] = ["allow", "deny", "ask"]

/** What a plugin can be asked for: what it declares, and what its providers need. */
export function simulatablePermissions(plugin: Plugin): PluginPermission[] {
  const permissions = new Set<PluginPermission>(plugin.manifest.permissions ?? [])
  try {
    for (const provider of normalizeIdeManifest(plugin.manifest.id, plugin.manifest).manifest
      .providers) {
      if (provider.permission) permissions.add(provider.permission)
    }
  } catch {
    // An invalid section is reported by the folder diagnostics; the declared
    // permissions are still worth simulating.
  }
  return [...permissions].sort()
}

export interface PermissionSimulationSectionProps {
  plugins: Plugin[]
  simulations: Array<{
    pluginId: string
    permission: PluginPermission
    decision: SimulatedDecision
  }>
}

export function PermissionSimulationSection({
  plugins,
  simulations,
}: PermissionSimulationSectionProps) {
  const t = useTranslations("plugins.devtools.managedIde.simulation")
  const ideTargets = useMemo(
    () => plugins.filter((plugin) => plugin.manifest.ide?.targets.includes("pro-ide")),
    [plugins]
  )
  const [pluginId, setPluginId] = useState("")
  const [permission, setPermission] = useState("")
  const [decision, setDecision] = useState<SimulatedDecision>("deny")
  const selected = ideTargets.find((plugin) => plugin.manifest.id === pluginId)
  const permissions = useMemo(() => (selected ? simulatablePermissions(selected) : []), [selected])

  if (ideTargets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="managed-ide-simulation-none">
        {t("noPlugins")}
      </p>
    )
  }

  return (
    <div className="space-y-3" data-testid="managed-ide-simulation">
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          value={pluginId}
          onValueChange={(value) => {
            setPluginId(value)
            setPermission("")
          }}
        >
          <SelectTrigger className="h-8 w-48 text-xs" aria-label={t("plugin")}>
            <SelectValue placeholder={t("pluginPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {ideTargets.map((plugin) => (
              <SelectItem key={plugin.manifest.id} value={plugin.manifest.id}>
                {plugin.manifest.name ?? plugin.manifest.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={permission} onValueChange={setPermission} disabled={!selected}>
          <SelectTrigger className="h-8 w-48 text-xs" aria-label={t("permission")}>
            <SelectValue placeholder={t("permissionPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {permissions.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={decision} onValueChange={(value) => setDecision(value as SimulatedDecision)}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label={t("decision")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DECISIONS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(`decisions.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="h-8"
          disabled={!selected || !permission}
          onClick={() => setSimulatedPermission(pluginId, permission as PluginPermission, decision)}
        >
          {t("apply")}
        </Button>
      </div>
      {simulations.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {simulations.map((entry) => (
            <li
              key={`${entry.pluginId}\0${entry.permission}`}
              className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
              data-testid={`managed-ide-simulation-${entry.pluginId}-${entry.permission}`}
            >
              <span className="font-medium">{entry.pluginId}</span>
              <Badge variant="outline" className="text-[10px]">
                {t("simulated")}
              </Badge>
              <span className="font-mono">{entry.permission}</span>
              <span className="flex-1">{t(`decisions.${entry.decision}`)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t("remove", { permission: entry.permission, pluginId: entry.pluginId })}
                onClick={() => setSimulatedPermission(entry.pluginId, entry.permission, null)}
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
