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

import { useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, GitCompareArrowsIcon, Loader2Icon, RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"

import type { ChatSession } from "@cognia/agent-config-types"
import { FidelityReport } from "@/components/session-import/fidelity-report"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { acknowledgeImportDivergence } from "@/lib/db/sessions"
import { resumeImportedSessionNative } from "@/lib/session-import/native-resume"
import { compositionForSession, useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
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
  const [resuming, setResuming] = useState(false)

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

  const canonicalStateCount = session.importCanonicalState
    ? Object.values(session.importCanonicalState).reduce(
        (count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
        0
      )
    : 0
  const fidelityDetails = session.importLossReport ? (
    <div className="max-w-sm space-y-2 p-1">
      <FidelityReport
        loss={session.importLossReport}
        sessionHeader={{
          source: {
            version: session.importSourceVersion,
            revision: session.importSourceRevision,
          },
          runtimeBinding: session.importRuntimeBinding,
          lineage: session.importRelation,
          lifecycle: session.importLifecycle,
        }}
      />
      {canonicalStateCount > 0 && (
        <p className="text-muted-foreground" data-testid="imported-canonical-state-summary">
          {t("canonicalState", { count: canonicalStateCount })}
        </p>
      )}
    </div>
  ) : null

  const origin = !session.importDiverged ? (
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
      <TooltipContent className="max-w-sm">
        {fidelityDetails ?? t("originHint", { source: label })}
      </TooltipContent>
    </Tooltip>
  ) : (
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
      <TooltipContent className="max-w-sm">
        <div className="space-y-2">
          <p>{t("divergedHint", { source: label })}</p>
          {fidelityDetails}
        </div>
      </TooltipContent>
    </Tooltip>
  )

  const binding = session.importRuntimeBinding
  const canAttemptNativeResume =
    session.importOwnership !== "cognia-owned" &&
    session.importOwnership !== "native-bound" &&
    Boolean(binding?.nativeSessionId && binding.presetId)
  if (!canAttemptNativeResume) return origin

  const resume = async () => {
    setResuming(true)
    let result: Awaited<ReturnType<typeof resumeImportedSessionNative>>
    try {
      // `resumeImportedSessionNative` only try/catches the resume handshake —
      // its dynamic `import(...)` of the external-agent manager and the
      // `getAllAgents()` call above it can still reject (a chunk-load failure
      // offline or against a stale deployment). Without this the `finally`
      // never ran, `void resume()` swallowed the rejection with no toast, and
      // the chip was left spinning on a disabled button until a remount.
      result = await resumeImportedSessionNative(session)
    } catch (error) {
      toast.error(t("resumeErrors.handshake-failed"), {
        description: error instanceof Error ? error.message : String(error),
      })
      return
    } finally {
      setResuming(false)
    }
    if (!result.ok) {
      toast.error(t(`resumeErrors.${result.code}`), {
        ...(result.detail ? { description: result.detail } : {}),
      })
      return
    }
    const runtime = useAgentRuntimeStore.getState()
    runtime.setSessionComposition(session.id, {
      ...compositionForSession(session.id),
      runtimeBindingRef: result.nativeSessionId,
    })
    runtime.setExternalAgentId(result.agentId)
    runtime.setRuntime("external")
    toast.success(t("resumeReady"))
  }

  return (
    <span className="inline-flex items-center gap-1">
      {origin}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void resume()}
            disabled={resuming}
            aria-label={t("resumeNative")}
            data-testid="imported-native-resume"
          >
            <Badge variant="outline" className="h-5 shrink-0 gap-1 px-1.5 text-[10px] font-normal">
              {resuming ? (
                <Loader2Icon className="size-3 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-3" />
              )}
              {t("resume")}
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{t("resumeNative")}</TooltipContent>
      </Tooltip>
    </span>
  )
}
