"use client"

/**
 * Who this template belongs to: one workspace, or every workspace.
 *
 * `lib/templates/scope.ts` keeps two questions apart on purpose. OWNERSHIP is
 * `TemplateDefinitionRow.workspaceId`, and a definition that has one does not
 * exist outside that workspace. VISIBILITY is the workspace capability overlay,
 * a per-workspace "I would rather not see this here" that only ever applies to
 * SHARED definitions and is edited on `/workspace` under Capabilities.
 *
 * This control is the ownership half, and it had no surface at all.
 * `TemplateService.setDefinitionWorkspace` existed with no production caller,
 * so a template could be confined to a workspace only at the moment it was
 * forked and could never be shared again. Ownership is stored on the local row
 * rather than in the envelope, so confining a template never reaches an export,
 * a package or a content hash. Moving it here changes who sees it and nothing
 * else.
 *
 * Rendered for every definition, disabled with the reason when it cannot move,
 * because hiding it would collapse "shared by construction" and "yours to
 * decide" into the same blank space.
 */

import { useTranslations } from "next-intl"
import { Building2Icon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { TemplateScopeTier } from "@/lib/templates/scope"

/** The two answers. `workspace` confines, `shared` releases the confinement. */
export const TEMPLATE_OWNERSHIP_CHOICES = ["workspace", "shared"] as const
export type TemplateOwnershipChoice = (typeof TEMPLATE_OWNERSHIP_CHOICES)[number]

/**
 * The shelves a user may move a template between.
 *
 * `builtin`, `plugin` and `marketplace` rows are not stored as local
 * definitions at all. They are catalog overlays, and `putLocal` only modifies
 * rows that exist in Dexie, so a control offered for one would appear to work
 * and change nothing. Fork one first, and the copy is `mine` and can be
 * confined.
 */
const MOVABLE_TIERS: ReadonlySet<TemplateScopeTier> = new Set(["mine", "workspace"])

/** Why the control cannot be used, or `undefined` when it can. */
export type TemplateScopeBlocker = "sharedSource" | "noWorkspace"

export function templateScopeBlocker(
  tier: TemplateScopeTier,
  activeWorkspaceId: string | null | undefined
): TemplateScopeBlocker | undefined {
  if (!MOVABLE_TIERS.has(tier)) return "sharedSource"
  // Confining needs a workspace to confine TO. The project store hydrates
  // asynchronously, so this is "not yet" rather than "never", which is why it
  // carries its own reason.
  if (!activeWorkspaceId) return "noWorkspace"
  return undefined
}

export interface TemplateScopeControlProps {
  /** Which shelf the definition sits on, from `templateScopeTier`. */
  tier: TemplateScopeTier
  /** The workspace that owns it today, from `listTemplateOwners`. */
  ownerWorkspaceId?: string
  /** The active workspace. Absent while the project store is still hydrating. */
  activeWorkspaceId?: string | null
  /** A write is in flight, so the control stays visible but stops taking taps. */
  busy?: boolean
  /**
   * Confine to `workspaceId`, or share again with `null`, which is exactly the
   * shape `TemplateService.setDefinitionWorkspace` takes.
   */
  onChange: (workspaceId: string | null) => void
}

export function TemplateScopeControl({
  tier,
  ownerWorkspaceId,
  activeWorkspaceId,
  busy = false,
  onChange,
}: TemplateScopeControlProps) {
  const t = useTranslations("templateStudio.scopeControl")
  const blocker = templateScopeBlocker(tier, activeWorkspaceId)
  const value: TemplateOwnershipChoice = ownerWorkspaceId === undefined ? "shared" : "workspace"

  return (
    <Surface
      layer="raised"
      radius="control"
      className="space-y-2 p-3"
      data-testid="template-scope-control"
      data-blocked={blocker ?? ""}
    >
      <div className="flex items-center gap-2">
        <Building2Icon className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("title")}
        </h3>
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        disabled={busy || blocker !== undefined}
        aria-label={t("title")}
        className="text-xs"
        onValueChange={(next) => {
          // Radix clears the value when the active item is clicked again.
          // Keeping the current answer is the honest response to "no change".
          if (!next || next === value) return
          onChange(next === "workspace" ? (activeWorkspaceId ?? null) : null)
        }}
      >
        {TEMPLATE_OWNERSHIP_CHOICES.map((choice) => (
          <ToggleGroupItem key={choice} value={choice} data-testid={`template-scope-${choice}`}>
            {t(`choice.${choice}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-xs text-muted-foreground" data-testid="template-scope-reason">
        {blocker ? t(`blocked.${blocker}`) : t(`explain.${value}`)}
      </p>
    </Surface>
  )
}
