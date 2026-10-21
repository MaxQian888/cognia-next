"use client"

import { useCallback, useEffect, useState } from "react"
import type { PluginAgentConfigFacts, PluginAgentConfigSurfaceListing } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button } from "@cognia/plugin-ui"

import { PLUGIN_ID } from "../model"
import { hasPromptCenterEntry, type GovernanceRuntime } from "../runtime/runtime"
import { act } from "./act"
import type { GovernanceData } from "./use-governance"

export interface InventoryTabProps {
  runtime: GovernanceRuntime
  workspaceId: string | null
  data: GovernanceData
  busy: boolean
}

type Loaded<T> =
  { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string }

/** Loads once per `load` identity; the parent remounts the tab when stored data changes. */
function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    load().then(
      (value) => {
        if (!cancelled) setState({ status: "ready", value })
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [load])
  return state
}

export function InventoryTab({ runtime, workspaceId, data, busy }: InventoryTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const loadListing = useCallback(() => runtime.surfaces(workspaceId), [runtime, workspaceId])
  const loadFacts = useCallback(() => runtime.facts(workspaceId), [runtime, workspaceId])
  const listing = useLoaded<PluginAgentConfigSurfaceListing>(loadListing)
  const facts = useLoaded<PluginAgentConfigFacts>(loadFacts)
  const audited = new Map((data.run?.surfaces ?? []).map((entry) => [entry.surface.key, entry]))
  const counts = new Map<string, number>()
  for (const finding of data.findings) {
    if (data.kept.has(finding.id)) continue
    counts.set(finding.location.surfaceKey, (counts.get(finding.location.surfaceKey) ?? 0) + 1)
  }

  return (
    <div className="space-y-3 p-3" data-testid="governance-inventory">
      {facts.status === "ready" && (
        <section className="space-y-1 rounded-md border p-2 text-xs" data-testid="governance-facts">
          <h3 className="font-semibold">{t("inventory.factsTitle")}</h3>
          <p className="text-muted-foreground">
            {t("inventory.factsLine", {
              hooks: facts.value.hooksAvailable ? facts.value.hooks.length : "—",
              rules: facts.value.permissionRules.length,
              servers: facts.value.mcpServers.length,
              skills: facts.value.skills.enabled,
              skillsTotal: facts.value.skills.total,
            })}
          </p>
          {!facts.value.hooksAvailable && (
            <p className="text-muted-foreground">{t("inventory.hooksUnavailable")}</p>
          )}
          <p className="text-[11px] text-muted-foreground">{t("inventory.factsPrivacy")}</p>
        </section>
      )}
      {listing.status === "loading" && (
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      )}
      {listing.status === "error" && <p className="text-xs text-destructive">{listing.message}</p>}
      {listing.status === "ready" && (
        <>
          {listing.value.failed.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t("inventory.failed", { sources: listing.value.failed.join(", ") })}
            </p>
          )}
          <ul className="space-y-1">
            {listing.value.surfaces.map((surface) => {
              const entry = audited.get(surface.key)
              return (
                <li
                  key={surface.key}
                  className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-medium"
                    title={surface.path ?? surface.key}
                  >
                    {surface.name}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(`source.${surface.source}`)}
                  </Badge>
                  {surface.loadOrder !== undefined && (
                    <span className="text-[10px] text-muted-foreground">
                      {t("inventory.loadOrder", { order: surface.loadOrder + 1 })}
                    </span>
                  )}
                  {surface.builtIn && !surface.modified && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("inventory.shipped")}
                    </Badge>
                  )}
                  {surface.modified && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("inventory.modified")}
                    </Badge>
                  )}
                  {entry?.skipped && (
                    <Badge variant="outline" className="text-[10px]">
                      {t(`skipped.${entry.skipped}`)}
                    </Badge>
                  )}
                  {(counts.get(surface.key) ?? 0) > 0 && (
                    <Badge className="text-[10px]">
                      {t("inventory.findings", { count: counts.get(surface.key) ?? 0 })}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy}
                    onClick={() => act(runtime.audit(workspaceId, [surface.key]), t)}
                  >
                    {t("inventory.auditOne")}
                  </Button>
                  {hasPromptCenterEntry(surface.key) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => runtime.openInPromptCenter(surface.key, workspaceId)}
                    >
                      {t("common.openInPromptCenter")}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
