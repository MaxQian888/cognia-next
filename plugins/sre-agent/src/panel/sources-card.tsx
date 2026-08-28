"use client"

import { useEffect, useState } from "react"
import { cn } from "@cognia/plugin-ui"
import type { SreIngestSource, SreIngestStatus } from "../providers/types"
import type { SreRuntime } from "../runtime"
import { usePluginT } from "../use-plugin-t"

const STATUS_TONE: Record<SreIngestStatus, string> = {
  healthy: "text-green-700 dark:text-green-500",
  lagging: "text-amber-700 dark:text-amber-500",
  stalled: "text-destructive",
  static: "text-muted-foreground",
}

/**
 * Where the evidence comes from, and whether that pipe is keeping up.
 *
 * This is the collection half of the product: an investigation run against a
 * source that is 47s behind is a different investigation, and the panel has to
 * say so rather than let a stale window read as a quiet one. A backend with no
 * pipeline at all reports `static` with null lag — see the fixture provider.
 */
export function SourcesCard({ runtime }: { runtime: SreRuntime }) {
  const t = usePluginT()
  const [sources, setSources] = useState<SreIngestSource[] | null>(null)

  useEffect(() => {
    let cancelled = false
    runtime
      .sources()
      .then((next) => {
        if (!cancelled) setSources(next)
      })
      .catch(() => {
        if (!cancelled) setSources([])
      })
    return () => {
      cancelled = true
    }
  }, [runtime])

  if (!sources) return null

  return (
    <section className="space-y-1.5" data-testid="sre-sources">
      <h3 className="text-xs font-medium">{t("sources.title")}</h3>
      <ul className="divide-y">
        {sources.map((source) => (
          <li key={source.id} className="flex items-center gap-2 py-1.5" data-testid="sre-source">
            <span className="min-w-0 flex-1 truncate text-xs">
              {source.label}
              <span className="ml-1.5 text-muted-foreground">{source.pipeline}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {source.recordCount === null
                ? null
                : `${t("sources.records", { count: source.recordCount.toLocaleString() })} · `}
              {source.lagMs === null
                ? t("sources.noLag")
                : t("sources.lag", { ms: source.lagMs.toLocaleString() })}
            </span>
            <span className={cn("w-16 shrink-0 text-right text-xs", STATUS_TONE[source.status])}>
              {t(`sources.status.${source.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
