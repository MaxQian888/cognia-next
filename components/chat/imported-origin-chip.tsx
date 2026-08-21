"use client"

/**
 * "Imported from …" chip for a conversation that came from an external coding
 * agent's on-disk history (ADR-0062), plus the divergence warning that
 * `lib/data/import-merge.ts` has documented from the beginning:
 *
 *   > source-side edits must never touch it (they surface as a "diverged"
 *   > badge instead)
 *
 * That badge did not exist. Nothing in the app read `importFrozen` at all, so
 * an imported conversation was visually indistinguishable from a native one,
 * and a user who kept working in BOTH Cognia and the original agent was never
 * told the two had drifted apart — Cognia simply stopped mirroring, silently.
 *
 * Two states, one chip:
 *   • imported          — names the source agent. Informational.
 *   • imported+diverged — the source moved after Cognia took ownership.
 *     Clicking acknowledges it (`acknowledgeImportDivergence`), so the warning
 *     is a notification rather than permanent furniture.
 *
 * Renders nothing for a session that was not imported. Sibling of
 * {@link BranchLineageChip}; both self-hide and can show together.
 */

import { useTranslations } from "next-intl"
import { DownloadIcon, GitCompareArrowsIcon } from "lucide-react"

import type { ChatSession } from "@cognia/agent-config-types"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { acknowledgeImportDivergence } from "@/lib/db/sessions"
import { cn } from "@/lib/utils"

export function ImportedOriginChip({
  session,
  className,
}: {
  session: ChatSession
  className?: string
}) {
  const t = useTranslations("chat.imported")
  const tSources = useTranslations("sessionImport.sources")

  // `importSource` is stamped by `importSessions`; the id prefix is the
  // fallback for rows written before the field existed.
  const source = session.importSource ?? (session.id.startsWith("import:") ? "" : null)
  if (source === null) return null

  // Same rule as the import dialog: a plugin source is namespaced
  // `${pluginId}:${id}` and has no catalog entry, so translating it would print
  // the raw key path. Built-ins render from the catalogue (localized); everything
  // else uses the label stamped at import time, which — unlike a registry lookup
  // — still resolves after the contributing plugin is uninstalled. Deliberately
  // NOT a registry lookup: that would pull all seven session parsers into the
  // chat header's bundle to render one chip.
  const label = !source
    ? (session.importSourceLabel ?? t("unknownSource"))
    : source.includes(":")
      ? (session.importSourceLabel ?? source)
      : tSources(source as never)

  if (!session.importDiverged) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className={cn("h-5 shrink-0 gap-1 px-1.5 text-[10px] font-normal", className)}
            data-testid="imported-origin-chip"
          >
            <DownloadIcon className="size-3" />
            {t("origin", { source: label })}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{t("originHint", { source: label })}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void acknowledgeImportDivergence(session.id)}
          aria-label={t("divergedHint", { source: label })}
          data-testid="imported-diverged-chip"
        >
          <Badge
            variant="outline"
            className={cn(
              "h-5 shrink-0 gap-1 border-amber-500/50 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400",
              className
            )}
          >
            <GitCompareArrowsIcon className="size-3" />
            {t("diverged", { source: label })}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{t("divergedHint", { source: label })}</TooltipContent>
    </Tooltip>
  )
}
