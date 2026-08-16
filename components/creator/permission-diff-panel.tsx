"use client"

/**
 * Step 4 — the permission diff and its approval (ADR-0117).
 *
 * Three properties this panel is responsible for:
 *
 *  - The **added** list is shown first and is the only thing the approve button
 *    covers. Removals and unchanged lines are informational.
 *  - Approval is bound to the exact set of additions it was granted for. If the
 *    generator re-runs and asks for more, `approvalCoversDiff` returns false and
 *    the panel says so instead of silently keeping the old approval alive.
 *  - It states plainly that no file is written until this passes, because that
 *    is the guarantee the user is being asked to rely on.
 */

import { useTranslations } from "next-intl"
import { Minus, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { approvalCoversDiff } from "@/lib/creator/permission-diff"
import type { CreatorPermissionDiff } from "@/types/creator"

export interface PermissionDiffPanelProps {
  diff: CreatorPermissionDiff
  approvedAdditions: readonly string[]
  onApprove: (additions: readonly string[]) => void
  disabled?: boolean
}

export function PermissionDiffPanel({
  diff,
  approvedAdditions,
  onApprove,
  disabled = false,
}: PermissionDiffPanelProps) {
  const t = useTranslations("creator.permissions")
  const covered = approvalCoversDiff(approvedAdditions, diff)
  // Stale = the user approved something, but not this. Distinct from "not yet
  // approved", and the difference matters: it means the proposal moved.
  const stale = !covered && approvedAdditions.length > 0

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        {covered && diff.requiresApproval ? (
          <Badge variant="outline" className="text-[10px]">
            {t("approved")}
          </Badge>
        ) : null}
      </div>

      {diff.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {diff.changes.map((change) => (
            <li key={`${change.change}:${change.capability}`} className="flex items-start gap-2">
              {change.change === "added" ? (
                <Plus className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
              ) : change.change === "removed" ? (
                <Minus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <span className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <code className="break-all text-xs">{change.capability}</code>
                <span className="ml-2 text-xs text-muted-foreground">{t(change.change)}</span>
                {change.rationale ? (
                  <span className="block text-xs text-muted-foreground">{change.rationale}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {diff.requiresApproval ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t("requiresApproval", { count: diff.added.length })}
          </p>
          {stale ? (
            <p className="text-xs text-destructive" role="alert">
              {t("stale")}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("writesBlocked")}</p>
          <Button size="sm" onClick={() => onApprove(diff.added)} disabled={disabled || covered}>
            {t("approve")}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export default PermissionDiffPanel
