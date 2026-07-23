"use client"

/**
 * Dataset version snapshots (Approach A). Lists immutable snapshots
 * newest-first with their short content hash + case count, and lets the user
 * tag a version (e.g. "prod"). Runs pin to a `datasetVersionId`, so tagged
 * versions are the stable comparison anchors.
 *
 * Snapshots used to be write-only here: listable and taggable, but with no way
 * to see what changed between two runs' pinned versions and no way back after a
 * bad edit. "Run A scored 80%, run B scored 60%" is unactionable without
 * knowing which cases moved underneath them, so this pane now compares two
 * snapshots and restores one — restore behind an explicit confirmation, since
 * it deletes cases.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GitCompareIcon, RotateCcwIcon, TagIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { restoreVersion, tagVersion } from "@/lib/db/eval-dataset-versions"
import { diffVersions, planRestore, versionCaseIds } from "@/lib/ai/eval/version-diff"
import { useEvalCases, useEvalDatasetVersions } from "@/hooks/eval/use-eval-data"
import { snapshotCaseCount } from "@/types/eval/version"

export function VersionHistory({ datasetId }: { datasetId: string }) {
  const t = useTranslations("eval")
  const versions = useEvalDatasetVersions(datasetId)
  const cases = useEvalCases(datasetId)
  const [tagging, setTagging] = useState<string | null>(null)
  const [tag, setTag] = useState("")
  const [compareFrom, setCompareFrom] = useState<string | null>(null)
  // Restore deletes cases, so the first click only confirms.
  const [restoreAck, setRestoreAck] = useState<string | null>(null)
  const [restored, setRestored] = useState<{ deleted: number; readded: number } | null>(null)

  const casesById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])
  const currentIds = useMemo(() => cases.map((c) => c.id), [cases])

  const applyTag = async (id: string) => {
    await tagVersion(id, tag.trim())
    setTagging(null)
    setTag("")
  }

  const doRestore = useCallback(
    async (versionId: string) => {
      if (restoreAck !== versionId) {
        setRestoreAck(versionId)
        return
      }
      setRestoreAck(null)
      setRestored(await restoreVersion(versionId))
    },
    [restoreAck]
  )

  if (versions.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("versions.empty")}</p>
  }

  const from = versions.find((v) => v.id === compareFrom)

  return (
    <div className="flex flex-col gap-2" data-testid="version-history">
      {restored && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
          {t("versions.restoreDone", restored)}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {versions.map((v) => {
          const plan = planRestore(v, currentIds)
          const confirming = restoreAck === v.id
          const diff = from && from.id !== v.id ? diffVersions(from, v, casesById) : null
          return (
            <li
              key={v.id}
              className="motion-safe:animate-in motion-safe:fade-in flex flex-col gap-1 rounded-md border p-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{t("versions.version", { version: v.version })}</Badge>
                  <span className="text-muted-foreground font-mono text-xs">
                    {v.casesHash.slice(0, 8)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t("versions.cases", { count: snapshotCaseCount(v) })}
                  </span>
                  {v.tag && <Badge>{v.tag}</Badge>}
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant={compareFrom === v.id ? "secondary" : "ghost"}
                    aria-pressed={compareFrom === v.id}
                    aria-label={t("versions.compare")}
                    onClick={() => setCompareFrom((cur) => (cur === v.id ? null : v.id))}
                  >
                    <GitCompareIcon className="size-4" />
                    {t("versions.compare")}
                  </Button>
                  <Button
                    size="sm"
                    variant={confirming ? "destructive" : "ghost"}
                    aria-label={t("versions.restore")}
                    onClick={() => void doRestore(v.id)}
                  >
                    <RotateCcwIcon className="size-4" />
                    {t("versions.restore")}
                  </Button>
                  {tagging === v.id ? (
                    <span className="flex items-center gap-1">
                      <Input
                        aria-label={t("versions.tagPlaceholder")}
                        placeholder={t("versions.tagPlaceholder")}
                        value={tag}
                        onChange={(e) => setTag(e.target.value)}
                        className="h-7 w-28"
                      />
                      <Button size="sm" onClick={() => void applyTag(v.id)}>
                        {t("versions.applyTag")}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("versions.tag")}
                      onClick={() => {
                        setTagging(v.id)
                        setTag(v.tag ?? "")
                      }}
                    >
                      <TagIcon className="size-4" />
                      {t("versions.tag")}
                    </Button>
                  )}
                </div>
              </div>

              {confirming && (
                <p className="text-destructive text-xs" role="alert" data-testid="restore-confirm">
                  {t("versions.restoreConfirm", { deleted: plan.toDelete.length })}
                  {plan.missing.length > 0
                    ? ` ${t("versions.restoreMissing", { count: plan.missing.length })}`
                    : ""}
                </p>
              )}

              {diff && (
                <div className="text-xs" data-testid="version-diff">
                  <p className="text-muted-foreground">
                    {t("versions.diffHeading", { from: from.version, to: v.version })}
                  </p>
                  {diff.added.length === 0 &&
                  diff.removed.length === 0 &&
                  diff.changed.length === 0 ? (
                    <p className="text-muted-foreground">{t("versions.diffNone")}</p>
                  ) : (
                    <p className="tabular-nums">
                      {t("versions.diffCounts", {
                        added: diff.added.length,
                        removed: diff.removed.length,
                        changed: diff.changed.length,
                        unchanged: diff.unchanged.length,
                      })}
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {from && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {t("versions.compareWith")}: {t("versions.version", { version: from.version })} (
            {versionCaseIds(from).length})
          </span>
          <Button size="sm" variant="ghost" onClick={() => setCompareFrom(null)}>
            {t("versions.closeDiff")}
          </Button>
        </div>
      )}
    </div>
  )
}
