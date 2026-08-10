"use client"

/**
 * Twin inject-log panel for the Settings tab (M7).
 *
 * Subscribes to the M6 ring buffer (`lib/twin/runtime/inject-log`) and
 * renders the last 50 invocations for the active twin. With implicit
 * twin injection (character.twinId triggers it automatically), this
 * panel is the user's only window into "did my twin actually get used?"
 *
 * Restores safe historical entries from `agentTraces`; the ring buffer remains
 * the low-latency subscription cache for new invocations.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  readTwinInjectLog,
  readPersistedTwinInjectLog,
  subscribeTwinInjectLog,
  type TwinInjectLogEntry,
} from "@/lib/twin/runtime/inject-log"

const VISIBLE = 50

export function TwinInjectLogCard({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.injectLog")
  const prefersReducedMotion = useReducedMotion()
  const [entries, setEntries] = useState<TwinInjectLogEntry[]>(() => readTwinInjectLog())
  const [persisted, setPersisted] = useState<TwinInjectLogEntry[]>([])

  useEffect(() => {
    let active = true
    void readPersistedTwinInjectLog(twinId, VISIBLE)
      .then((history) => {
        if (active) setPersisted(history)
      })
      .catch(() => {
        // The ring buffer still provides live diagnostics if Dexie is unavailable.
      })
    const unsubscribe = subscribeTwinInjectLog(() => {
      // Refresh the snapshot — cheaper than appending one row given the
      // small buffer size and Radix's table cell churn cost.
      setEntries(readTwinInjectLog())
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [twinId])

  const filtered = [...entries, ...persisted]
    .filter((entry) => entry.twinId === twinId)
    .filter(
      (entry, index, all) =>
        all.findIndex((candidate) =>
          entry.id && candidate.id ? candidate.id === entry.id : candidate.ts === entry.ts
        ) === index
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, VISIBLE)

  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="twin-inject-log-card">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <span className="text-muted-foreground text-xs">
          {t("count", { count: filtered.length })}
        </span>
      </header>
      <p className="text-muted-foreground text-xs">{t("description")}</p>
      {filtered.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-xs italic">{t("emptyHint")}</p>
      ) : (
        <ScrollArea className="max-h-72">
          <ul className="flex flex-col gap-1 pr-2">
            {filtered.map((entry, i) => (
              <motion.li
                key={`${entry.ts}-${i}`}
                initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.15,
                  ease: "easeOut",
                  delay: prefersReducedMotion ? 0 : Math.min(i * 0.02, 0.1),
                }}
                className="border-border flex items-center justify-between gap-3 rounded border p-2 text-xs list-none"
                data-testid={`twin-inject-log-row-${i}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={entry.applied ? "default" : "outline"} className="text-[10px]">
                    {entry.applied ? t("applied") : t("skipped")}
                  </Badge>
                  {entry.degraded ? (
                    <Badge variant="destructive" className="text-[10px]">
                      {t("degraded")}
                    </Badge>
                  ) : null}
                  <span className="font-mono text-[10px]">{entry.source}</span>
                  {entry.applied ? (
                    <span className="text-muted-foreground">
                      {t("counts", {
                        chunks: entry.chunkCount,
                        samples: entry.styleSampleCount,
                        tokens: entry.tokensApprox,
                      })}
                    </span>
                  ) : entry.degradedReason ? (
                    <span className="text-destructive italic">{entry.degradedReason}</span>
                  ) : null}
                </div>
                <span className="text-muted-foreground shrink-0">
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
              </motion.li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Card>
  )
}
