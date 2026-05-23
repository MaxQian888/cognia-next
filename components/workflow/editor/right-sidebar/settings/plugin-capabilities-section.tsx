"use client"

/**
 * PluginCapabilitiesSection — lists the workflow capabilities contributed by
 * installed plugins: custom nodes + triggers (ADR-0017, via the node catalog)
 * and complete workflow templates (ADR-0032-style overlay registry —
 * `workflow-template-registry`).
 *
 * Nodes/triggers are read-only here (registration is owned by the plugin
 * manager). Templates carry `requires` warning chips and a "Use" action that
 * projects the blueprint into a new workflow.
 */

import { useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Boxes, FileStackIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  getPluginCatalogSnapshot,
  subscribePluginCatalog,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import {
  getWorkflowTemplateWarnings,
  listWorkflowTemplateEntries,
} from "@/lib/plugin/registries/workflow-template-registry"
import { projectPluginWorkflowTemplate } from "@/lib/workflow/templates/project-plugin-workflow-template"
import { createWorkflow } from "@/lib/db/workflows"

function usePluginCatalog(): readonly NodeCatalogEntry[] {
  return useSyncExternalStore(
    subscribePluginCatalog,
    getPluginCatalogSnapshot,
    getPluginCatalogSnapshot
  )
}

export function PluginCapabilitiesSection() {
  const t = useTranslations("workflowEditor.settings.plugins")
  const router = useRouter()
  const entries = usePluginCatalog()
  const triggers = entries.filter((e) => e.kind.includes("trigger"))
  const nodes = entries.filter((e) => !e.kind.includes("trigger"))
  // Re-read on each render (the section re-renders when the catalog changes;
  // template register/unregister rides the same plugin enable/disable cycle).
  const templates = listWorkflowTemplateEntries()

  if (entries.length === 0 && templates.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("empty")}</p>
  }

  const instantiateTemplate = async (entry: (typeof templates)[number]) => {
    try {
      const projected = projectPluginWorkflowTemplate(entry)
      const row = await createWorkflow({
        name: projected.name,
        description: projected.description,
        icon: projected.icon,
        nodes: projected.nodes,
        edges: projected.edges,
        settings: projected.settings,
        isTemplate: false,
      })
      router.push(`/workflows/${row.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-3" data-testid="plugin-capabilities-section">
      {nodes.length > 0 ? (
        <CapabilityGroup
          label={t("sections.nodes")}
          entries={nodes}
          contributedBy={t("contributedBy")}
        />
      ) : null}
      {triggers.length > 0 ? (
        <CapabilityGroup
          label={t("sections.triggers")}
          entries={triggers}
          contributedBy={t("contributedBy")}
        />
      ) : null}
      {templates.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("sections.templates")}
          </p>
          {templates.map(({ id, entry, pluginId }) => {
            const warnings = getWorkflowTemplateWarnings(id)
            return (
              <div
                key={id}
                className="rounded-md border bg-muted/20 px-2 py-1.5"
                data-testid={`plugin-template-${id}`}
              >
                <div className="flex items-start gap-2">
                  <FileStackIcon
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{entry.name}</p>
                    {pluginId ? (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {t("contributedBy").replace("{plugin}", pluginId)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => instantiateTemplate({ id, entry, pluginId })}
                    data-testid={`plugin-template-use-${id}`}
                  >
                    {t("useTemplate")}
                  </Button>
                </div>
                {warnings.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {warnings.map((w) => (
                      <span
                        key={`${w.code}:${w.missingId}`}
                        className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-700 dark:text-amber-300"
                      >
                        {t("missingDep").replace("{id}", w.missingId)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function CapabilityGroup({
  label,
  entries,
  contributedBy,
}: {
  label: string
  entries: readonly NodeCatalogEntry[]
  contributedBy: string
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {entries.map((entry) => (
        <div
          key={entry.kind}
          className="flex items-start gap-2 rounded-md border bg-muted/20 px-2 py-1.5"
          data-testid={`plugin-capability-${entry.kind}`}
        >
          <Boxes className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.label}</p>
            {entry.pluginId ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {contributedBy.replace("{plugin}", entry.pluginId)}
              </p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
