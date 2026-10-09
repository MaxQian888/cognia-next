"use client"

import Link from "next/link"
import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { getMemory } from "@/lib/db/memories"
import { getCapturedItem } from "@/lib/db/captured-items"
import { decideRadarSuggestion, radarSuggestions } from "@/lib/radar/suggestions"
import type { RadarReport } from "@/types/radar"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { RunArtifactLinks } from "@/components/scheduler/run-artifact-links"

export function RadarTaskResults({ taskId }: { taskId: string }) {
  const t = useTranslations("radar.decisions")
  const latest = useLiveQuery(async () => {
    try {
      return (await schedulerDb.getTaskExecutions(taskId, 1))[0] ?? null
    } catch {
      return null
    }
  }, [taskId])
  return (
    <div>
      <Link className="text-sm underline" href={`/scheduler?taskId=${encodeURIComponent(taskId)}`}>
        {t("track")}
      </Link>
      {latest?.output ? <RunArtifactLinks output={latest.output} /> : null}
    </div>
  )
}

export function RadarSource({ source }: { source: NonNullable<RadarReport["sources"]>[number] }) {
  const t = useTranslations("radar.decisions")
  // The app's locale, not the OS default `toLocaleString` would pick.
  const locale = useLocale()
  const item = useLiveQuery(async () => {
    try {
      if (source.source === "memory") {
        const memory = await getMemory(source.id)
        return memory?.status === "active" ? memory.text : null
      }
      const capture = await getCapturedItem(source.id)
      return capture
        ? capture.text || capture.enrichment?.markdown || capture.sourceUrl || ""
        : null
    } catch {
      return null
    }
  }, [source.source, source.id])
  return (
    <li className="text-xs text-muted-foreground">
      {t(source.source)} ·{" "}
      <time dateTime={new Date(source.at).toISOString()}>
        {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          source.at
        )}
      </time>
      {item === undefined ? (
        <span> — {t("loading")}</span>
      ) : item === null ? (
        <span> — {t("unavailable")}</span>
      ) : (
        <details>
          <summary>{t("viewSource")}</summary>
          <p className="whitespace-pre-wrap">{item.slice(0, 1200)}</p>
          {source.source === "memory" && (
            <Link href={`/memory?id=${encodeURIComponent(source.id)}`}>{t("openSource")}</Link>
          )}
        </details>
      )}
    </li>
  )
}

/** Decisions have their own pending/error state and remain attached to history. */
export function RadarSuggestions({ report }: { report: RadarReport }) {
  const t = useTranslations("radar.decisions")
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const decide = async (id: string, decision: "accepted" | "dismissed") => {
    setBusy(id)
    setError(undefined)
    try {
      await decideRadarSuggestion(report.id, id, decision)
    } catch {
      setError(t("failed"))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("acceptHelp")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {radarSuggestions(report).map((suggestion) => {
        const sources = (report.actionEvidence?.[suggestion.actionIndex] ?? []).flatMap((index) =>
          report.sources?.[index] ? [report.sources[index]] : []
        )
        return (
          <div key={suggestion.id} className="space-y-2 rounded border p-3">
            <p>{report.actions[suggestion.actionIndex]}</p>
            {sources.length ? (
              <ul>
                {sources.map((source) => (
                  <RadarSource key={`${source.source}:${source.id}`} source={source} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noEvidence")}</p>
            )}
            {suggestion.status === "pending" ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void decide(suggestion.id, "accepted")}
                >
                  {t("accept")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void decide(suggestion.id, "dismissed")}
                >
                  {t("dismiss")}
                </Button>
              </div>
            ) : (
              <p className="text-xs">{t(suggestion.status)}</p>
            )}
            {suggestion.taskId && <RadarTaskResults taskId={suggestion.taskId} />}
            {suggestion.dispatchError && (
              <div>
                <p role="status" className="text-xs">
                  {t("dispatchFailed")}
                </p>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void decide(suggestion.id, "accepted")}
                >
                  {t("retry")}
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
