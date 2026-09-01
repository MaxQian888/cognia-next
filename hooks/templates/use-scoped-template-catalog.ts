"use client"

/**
 * The template catalog as the active workspace sees it.
 *
 * The catalog itself is a pure in-memory store over portable envelopes, so it
 * cannot answer a workspace question: ownership lives on the stored row and
 * the hide-here preference lives on the workspace. Composing them here rather
 * than inside the catalog keeps that split intact and gives the desktop Studio
 * and the phone one answer instead of two that drift.
 */

import { useMemo } from "react"

import { useClientLiveQuery } from "@/hooks/data"
import { useTemplateCatalog } from "@/hooks/use-template-catalog"
import { listTemplateOwners } from "@/lib/db/template-platform"
import type { TemplateCatalogQuery } from "@/lib/templates/catalog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import {
  isTemplateVisibleInWorkspace,
  templateScopeTier,
  type TemplateScopeTier,
} from "@/lib/templates/scope"
import { capabilityStateOf } from "@/lib/workspace/capability-overlay"
import type { WorkspaceCapabilityOverlay } from "@/lib/workspace/capability-overlay"
import { useProjectStore } from "@/stores/project/project-store"

export interface ScopedTemplateCatalog {
  /** Visible in this workspace, after ownership and the hide-here overlay. */
  definitions: readonly TemplateDefinitionEnvelope[]
  /** Definition id to owning workspace, for anything that renders the tier. */
  owners: Record<string, string>
  tierOf: (definition: TemplateDefinitionEnvelope) => TemplateScopeTier
  /** How many the workspace is hiding, so the UI can say so rather than lie. */
  hiddenCount: number
  revision: number
}

export function useScopedTemplateCatalog(
  query: TemplateCatalogQuery = {},
  options: { tier?: TemplateScopeTier | "all" } = {}
): ScopedTemplateCatalog {
  const { definitions, revision } = useTemplateCatalog(query)
  const owners = useClientLiveQuery(() => listTemplateOwners(), [], {})
  const activeWorkspaceId = useProjectStore((s) => s.activeProjectId)
  const overlay = useProjectStore((s) => {
    const project = s.projects.find((candidate) => candidate.id === s.activeProjectId)
    return project?.capabilityOverlay as WorkspaceCapabilityOverlay | undefined
  })

  const tier = options.tier ?? "all"

  return useMemo(() => {
    // Defaulted inside the memo: a `?? {}` outside it is a fresh object on
    // every render, which would make this memo recompute every time.
    const ownerMap = owners ?? {}
    const visible: TemplateDefinitionEnvelope[] = []
    let hiddenCount = 0
    for (const definition of definitions) {
      const ownerWorkspaceId = ownerMap[definition.id]
      const shown = isTemplateVisibleInWorkspace({
        definition,
        ...(ownerWorkspaceId !== undefined ? { ownerWorkspaceId } : {}),
        activeWorkspaceId,
        hiddenHere: capabilityStateOf(overlay, "template", definition.id) === "off",
      })
      if (!shown) {
        hiddenCount += 1
        continue
      }
      if (tier !== "all" && templateScopeTier(definition, ownerWorkspaceId) !== tier) continue
      visible.push(definition)
    }
    return {
      definitions: visible,
      owners: ownerMap,
      tierOf: (definition: TemplateDefinitionEnvelope) =>
        templateScopeTier(definition, ownerMap[definition.id]),
      hiddenCount,
      revision,
    }
  }, [definitions, owners, activeWorkspaceId, overlay, tier, revision])
}
