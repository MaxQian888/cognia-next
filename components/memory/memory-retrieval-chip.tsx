"use client"

/**
 * Header status chip for memory recall.
 *
 * The retrieval control plane used to sit in the page body as a full Card with
 * four metric boxes that read `0/0/0/0` almost always — a permanent band of
 * chrome above the only content the page has. It is a *status*, so it renders
 * as one chip: green when recall is healthy, destructive when the kill switch
 * is engaged, with the live job count when work is in flight. The full control
 * panel is one click away in a popover.
 *
 * The chip also answers a question the old layout never did: whether recall is
 * actually hybrid. A user who never configured twin embeddings silently gets
 * BM25-only memory, and `describeMemoryRetrievalMode` is the single source of
 * truth for that gate.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, TypeIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RetrievalControlPanel } from "@/components/rag/retrieval-control-panel"
import { listRetrievalControlSnapshot } from "@/lib/db/retrieval-control"
import { getSettings } from "@/lib/db/settings"
import {
  describeMemoryRetrievalMode,
  type MemoryRetrievalMode,
} from "@/lib/memory/runtime/build-deps"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { cn } from "@/lib/utils"

/** Corpus namespace the memory subsystem writes its retrieval rows under. */
export const MEMORY_CORPUS_PREFIXES = ["memory:"] as const

const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "retry_wait"])

export interface MemoryRetrievalChipProps {
  /** Overrides the live probe in tests and stories. */
  mode?: MemoryRetrievalMode
}

export function MemoryRetrievalChip({ mode: modeOverride }: MemoryRetrievalChipProps = {}) {
  const t = useTranslations("memory.panel.retrieval")
  const [probed, setProbed] = useState<MemoryRetrievalMode | undefined>(undefined)

  const snapshot = useLiveQuery(
    () => listRetrievalControlSnapshot({ corpusPrefixes: MEMORY_CORPUS_PREFIXES }),
    []
  )

  useEffect(() => {
    if (modeOverride) return
    let cancelled = false
    void (async () => {
      try {
        const settings = await getSettings().catch(() => undefined)
        const result = await describeMemoryRetrievalMode(resolveMemoryConfig(settings?.memory))
        if (!cancelled) setProbed(result)
      } catch {
        // A failed probe leaves the chip in its "checking" state rather than
        // claiming a recall mode we could not confirm.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [modeOverride])

  const mode = modeOverride ?? probed
  const killSwitch = snapshot?.runtime.killSwitchEngaged ?? false
  const activeJobs = (snapshot?.jobs ?? []).filter((job) => ACTIVE_JOB_STATUSES.has(job.status))

  const { label, Icon, tone } = describeChip(mode, killSwitch, t)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 min-w-0 shrink gap-1.5 rounded-full border px-2 text-xs font-normal @3xl/feature-header:px-2.5",
            tone === "danger"
              ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
              : "border-border/70 bg-muted/40 text-muted-foreground hover:text-foreground"
          )}
          // The label collapses when the header is tight: this chip lives in the
          // header's `status` slot, which is a `shrink-0` sibling of the page
          // title, so a full-width chip squeezes the `<h1>` to zero. The state
          // stays in the accessible name either way.
          aria-label={`${label} — ${t("openPanel")}`}
          data-testid="memory-retrieval-chip"
          data-tone={tone}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden @3xl/feature-header:inline">{label}</span>
          {activeJobs.length > 0 ? (
            <Badge
              variant="secondary"
              className="h-4 px-1 text-[10px] tabular-nums"
              data-testid="memory-retrieval-chip-jobs"
            >
              {activeJobs.length}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto p-0"
      >
        <RetrievalControlPanel corpusPrefixes={MEMORY_CORPUS_PREFIXES} />
      </PopoverContent>
    </Popover>
  )
}

function describeChip(
  mode: MemoryRetrievalMode | undefined,
  killSwitch: boolean,
  t: (key: string) => string
): { label: string; Icon: typeof ShieldCheckIcon; tone: "danger" | "muted" } {
  // The kill switch outranks the recall mode: when retrieval is stopped, how it
  // *would* have recalled is not the thing the user needs to see.
  if (killSwitch) return { label: t("disabled"), Icon: ShieldAlertIcon, tone: "danger" }
  if (!mode) return { label: t("probing"), Icon: ShieldCheckIcon, tone: "muted" }
  if (mode.kind === "off") return { label: t("disabled"), Icon: ShieldAlertIcon, tone: "danger" }
  if (mode.kind === "hybrid") return { label: t("hybrid"), Icon: SparklesIcon, tone: "muted" }
  return { label: t("keyword"), Icon: TypeIcon, tone: "muted" }
}
