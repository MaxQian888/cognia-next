"use client"

/**
 * The rows that turn a three-way conflict into an answer.
 *
 * Shared by the two reconciliations the platform performs, because they are
 * the same question asked about different things: an instance taking a newer
 * release, and a fork taking a newer release of what it was forked from. Both
 * go through `lib/templates/payload-diff`, both refuse to write while a path
 * is unanswered, so both need exactly this control.
 *
 * Nothing is preselected. Each side of a conflict discards someone's work, so
 * a default would make one of those losses the quiet outcome of not looking.
 */

import { useTranslations } from "next-intl"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { TemplateConflictResolution, TemplateDiffResult } from "@/lib/templates/service"

export interface TemplateConflictListProps {
  conflicts: TemplateDiffResult["conflicts"]
  resolutions: Record<string, TemplateConflictResolution>
  onResolve: (path: string, choice: TemplateConflictResolution) => void
  testId?: string
}

/** Paths still waiting for an answer. Callers gate their confirm button on it. */
export function unresolvedPaths(
  conflicts: TemplateDiffResult["conflicts"],
  resolutions: Record<string, TemplateConflictResolution>
): string[] {
  return conflicts.map((c) => c.path).filter((path) => resolutions[path] === undefined)
}

export function TemplateConflictList({
  conflicts,
  resolutions,
  onResolve,
  testId = "template-update-conflicts",
}: TemplateConflictListProps) {
  const t = useTranslations("templateStudio.updateDialog")
  if (conflicts.length === 0) return null
  const pending = unresolvedPaths(conflicts, resolutions).length

  return (
    <section className="space-y-2" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("conflicts", { count: conflicts.length })}
      </h3>
      <ul className="max-h-52 space-y-1.5 overflow-y-auto">
        {conflicts.map((conflict) => (
          <li key={conflict.path} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{conflict.path}</span>
            <ToggleGroup
              type="single"
              size="sm"
              value={resolutions[conflict.path] ?? ""}
              aria-label={t("resolutionLabel", { path: conflict.path })}
              onValueChange={(value) => {
                // Radix clears the value when the active item is clicked again.
                // An answered conflict stays answered.
                if (!value) return
                onResolve(conflict.path, value as TemplateConflictResolution)
              }}
              className="text-xs"
            >
              <ToggleGroupItem value="local" data-testid={`template-update-keep-${conflict.path}`}>
                {t("keepLocal")}
              </ToggleGroupItem>
              <ToggleGroupItem
                value="upstream"
                data-testid={`template-update-take-${conflict.path}`}
              >
                {t("takeUpstream")}
              </ToggleGroupItem>
            </ToggleGroup>
          </li>
        ))}
      </ul>
      {pending > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="template-update-pending">
          {t("unresolved", { count: pending })}
        </p>
      ) : null}
    </section>
  )
}
