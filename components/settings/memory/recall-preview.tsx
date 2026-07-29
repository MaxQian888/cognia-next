"use client"

/**
 * Two answers to two different questions, which is why there are two mechanisms.
 *
 *  - The budget bar answers "what does this slider cost?" on every drag frame.
 *    It is a pure function of config + corpus averages; it runs no retrieval.
 *  - The dry-run answers "what would actually be injected?" and does so by
 *    calling `applyMemoryContext` — literally the same entry point
 *    `build-options.ts` uses for a real turn — so the list is not a simulation.
 *
 * The dry-run strips `deps.touch`: bumping `lastAccessedAt`/`accessCount` from a
 * settings preview would skew decay scoring and the idle-expiry clock for
 * memories the user never actually recalled.
 */

import { useState } from "react"
import { motion } from "motion/react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, FlaskConicalIcon, Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"
import { MOBILE_DURATION, MOBILE_EASE, MOBILE_SPRING, STAGGER_INTERVAL } from "@/lib/ui/motion"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { estimateRecallBudget } from "@/lib/memory/insights"
import type { MemoryConfig } from "@/types/memory/memory"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface DryRunHit {
  id: string
  text: string
  relevance: number
}

interface DryRunResult {
  hits: DryRunHit[]
  /** The relevance floor the run itself used — raising it filters client-side. */
  ranAtFloor: number
  usedTokens: number
  limitTokens: number
  withheldCount: number
  proceduralCount: number
  /** The backend threw; this is NOT the same as keyword-only retrieval. */
  degraded: boolean
}

export interface RecallPreviewProps {
  config: MemoryConfig
  averageTokens: number
  activeCount: number
}

export function RecallPreview({ config, averageTokens, activeCount }: RecallPreviewProps) {
  const t = useTranslations("settings.memory.preview")
  const { reduce, durationScale } = useFlowMotion()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DryRunResult | null>(null)

  const budget = estimateRecallBudget({
    averageTokens,
    activeCount,
    topK: config.retrievalTopK,
    tokenBudget: config.recallTokenBudget,
  })

  const runDryRun = async () => {
    const trimmed = query.trim()
    // `applyMemoryContext` throws on an empty query — block it at the edge.
    if (!trimmed || running) return
    setRunning(true)
    setError(null)
    try {
      const [{ tryBuildMemoryDeps }, { applyMemoryContext }] = await Promise.all([
        import("@/lib/memory/runtime/build-deps"),
        import("@/lib/memory/runtime/apply-memory-context"),
      ])
      const deps = await tryBuildMemoryDeps(config)
      if (!deps) {
        setResult(null)
        setError(t("errors.unavailable"))
        return
      }
      const applied = await applyMemoryContext({
        userMessage: trimmed,
        topK: config.retrievalTopK,
        relevanceFloor: config.relevanceFloor,
        maxTokens: config.recallTokenBudget,
        enableQueryExpansion: config.enableQueryExpansion,
        recencyHalfLifeDays: config.decayHalfLifeDays,
        // A preview must not count as a recall.
        deps: { ...deps, touch: undefined },
      })
      setResult({
        hits: applied.retrievedMemories.map((m) => ({
          id: m.id,
          text: m.text,
          relevance: m.relevance,
        })),
        ranAtFloor: config.relevanceFloor,
        usedTokens: applied.budget.used,
        limitTokens: applied.budget.limit,
        withheldCount: applied.withheldCount,
        proceduralCount: applied.proceduralCount,
        degraded: applied.degraded,
      })
    } catch {
      setResult(null)
      setError(t("errors.failed"))
    } finally {
      setRunning(false)
    }
  }

  // Raising the floor after a run can only remove hits, so it is honest to
  // filter client-side. Lowering it could reveal hits the run never fetched —
  // that needs a re-run, and the hint below says so.
  const floorRaised = result !== null && config.relevanceFloor > result.ranAtFloor
  const floorLowered = result !== null && config.relevanceFloor < result.ranAtFloor

  return (
    <div
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      data-testid="memory-recall-preview"
    >
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">{t("budget.title")}</p>
          <p
            className={cn(
              "text-xs tabular-nums",
              budget.overBudget ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
            )}
            data-testid="memory-budget-readout"
          >
            {t("budget.readout", {
              used: budget.estimatedTokens,
              limit: budget.tokenBudget,
            })}
          </p>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={t("budget.title")}
          aria-valuenow={budget.estimatedTokens}
          aria-valuemin={0}
          aria-valuemax={budget.tokenBudget}
        >
          <motion.div
            className={cn("h-full rounded-full", budget.overBudget ? "bg-amber-500" : "bg-primary")}
            initial={false}
            animate={{ width: `${budget.fill * 100}%` }}
            transition={reduce ? { duration: 0 } : MOBILE_SPRING}
            data-testid="memory-budget-bar"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("budget.basis", { lines: budget.lines, avg: Math.round(averageTokens) })}
        </p>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-1.5 px-1 text-xs"
            data-testid="memory-dryrun-toggle"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")}
            />
            {t("dryRun.title")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void runDryRun()
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("dryRun.placeholder")}
              aria-label={t("dryRun.inputLabel")}
              className="h-8 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 gap-1.5"
              disabled={running || query.trim().length === 0}
              data-testid="memory-dryrun-run"
            >
              {running ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <FlaskConicalIcon className="size-3.5" />
              )}
              {t("dryRun.run")}
            </Button>
          </form>

          {config.allowCloudEmbedding ? (
            <p className="text-[11px] text-muted-foreground">{t("dryRun.cloudNotice")}</p>
          ) : null}

          {error ? (
            <p className="text-[11px] text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          {result ? (
            <div className="space-y-1.5" data-testid="memory-dryrun-result">
              {result.degraded ? (
                <p className="text-[11px] text-destructive" role="alert">
                  {t("dryRun.degraded")}
                </p>
              ) : null}
              {result.hits.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t("dryRun.empty")}</p>
              ) : (
                result.hits.map((hit, index) => {
                  const excluded = hit.relevance < config.relevanceFloor
                  return (
                    <motion.div
                      key={hit.id}
                      initial={reduce ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: excluded ? 0.45 : 1, y: 0 }}
                      transition={
                        reduce
                          ? { duration: 0 }
                          : {
                              duration: MOBILE_DURATION.fast * durationScale,
                              ease: MOBILE_EASE,
                              delay: index * STAGGER_INTERVAL,
                            }
                      }
                      className="flex items-start gap-2 text-[11px]"
                      data-testid="memory-dryrun-hit"
                      data-excluded={excluded ? "true" : undefined}
                    >
                      <Badge
                        variant={excluded ? "outline" : "secondary"}
                        className="shrink-0 px-1 tabular-nums"
                      >
                        {hit.relevance.toFixed(2)}
                      </Badge>
                      <span className={cn("min-w-0 flex-1", excluded && "line-through")}>
                        {hit.text}
                      </span>
                    </motion.div>
                  )
                })
              )}
              <p
                className="pt-1 text-[11px] text-muted-foreground"
                data-testid="memory-dryrun-summary"
              >
                {t("dryRun.summary", {
                  count: result.hits.filter((h) => h.relevance >= config.relevanceFloor).length,
                  used: result.usedTokens,
                  limit: result.limitTokens,
                  withheld: result.withheldCount,
                  procedural: result.proceduralCount,
                })}
              </p>
              {floorRaised ? (
                <p className="text-[11px] text-muted-foreground">{t("dryRun.floorRaised")}</p>
              ) : null}
              {floorLowered ? (
                <p className="text-[11px] text-muted-foreground">{t("dryRun.floorLowered")}</p>
              ) : null}
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
