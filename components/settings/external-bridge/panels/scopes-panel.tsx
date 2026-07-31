"use client"

/**
 * Settings → External Bridge → Permission scopes.
 *
 * All 19 `BridgeScope`s, bucketed by namespace. They used to render as one flat
 * list of raw `namespace:verb` strings — and the section's own header comment
 * claimed there were nine, which had been wrong for a long time.
 *
 * `wiki:user-repo` and `rag:user-repo` are deferred past Phase 1. They were
 * already rendered with a `disabled` Switch and NO explanation, which is the
 * exact "built but dormant, and silent about it" shape Working Rule 7 exists to
 * prevent: the type documented the deferral, the UI did not. Each now carries a
 * "planned" badge and a reason, pinned by `scopes-panel.test.tsx`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ALL_BRIDGE_SCOPES, type BridgeScope, type ExternalBridgeSettings } from "@/types/wiki"

import { groupBridgeScopes } from "../nav-config"

/**
 * Scopes deferred past Phase 1 (plan M3). Kept in `ALL_BRIDGE_SCOPES` because
 * the handlers and the permission gate already understand them; only the grant
 * is withheld.
 */
export const PHASE_1_DISABLED_SCOPES: BridgeScope[] = ["wiki:user-repo", "rag:user-repo"]

export interface BridgeScopesPanelProps {
  settings: ExternalBridgeSettings
  onChange: (next: ExternalBridgeSettings) => void
}

export function BridgeScopesPanel({ settings, onChange }: BridgeScopesPanelProps) {
  const t = useTranslations("settings.externalBridge")
  const enabledSet = useMemo(() => new Set(settings.enabledScopes), [settings.enabledScopes])
  const groups = useMemo(() => groupBridgeScopes(ALL_BRIDGE_SCOPES), [])

  const onToggleScope = (scope: BridgeScope, enabled: boolean) => {
    if (PHASE_1_DISABLED_SCOPES.includes(scope)) return
    const next = new Set(enabledSet)
    if (enabled) next.add(scope)
    else next.delete(scope)
    onChange({ ...settings, enabledScopes: Array.from(next) })
  }

  const grantedCount = ALL_BRIDGE_SCOPES.filter((s) => enabledSet.has(s)).length

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("scopes.title")}
        description={t("scopes.description")}
        badge={t("scopes.grantedCount", {
          granted: grantedCount,
          total: ALL_BRIDGE_SCOPES.length,
        })}
        badgeVariant="secondary"
      >
        {groups.map((group) => (
          <div key={group.id} className="space-y-2" data-testid={`bridge-scope-group-${group.id}`}>
            <div className="flex items-center gap-2">
              <group.icon className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`scopes.groups.${group.id}`)}
              </span>
            </div>
            <div className="space-y-1.5">
              {group.scopes.map((scope) => {
                const checked = enabledSet.has(scope)
                const planned = PHASE_1_DISABLED_SCOPES.includes(scope)
                return (
                  <div
                    key={scope}
                    className={cn(
                      "flex items-start justify-between gap-3 rounded border bg-card px-3 py-2",
                      planned && "border-dashed bg-muted/30"
                    )}
                    data-testid={`bridge-scope-row-${scope}`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Label className="font-mono text-xs">{scope}</Label>
                        {planned && (
                          <Badge
                            variant="outline"
                            className="text-[10px]"
                            data-testid={`bridge-scope-planned-${scope}`}
                          >
                            {t("scopes.plannedBadge")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t(`scopeDescriptions.${scope}`)}
                      </p>
                      <MotionCollapse open={planned}>
                        <p className="text-[11px] text-muted-foreground">
                          {t("scopes.plannedReason")}
                        </p>
                      </MotionCollapse>
                    </div>
                    <Switch
                      checked={checked}
                      disabled={planned}
                      onCheckedChange={(v) => onToggleScope(scope, v)}
                      aria-label={t("scopes.toggleAria", { scope })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </SettingsCard>
    </div>
  )
}
