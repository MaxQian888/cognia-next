"use client"

/**
 * PanelVersionHistory - Version history panel for ArtifactPanel.
 *
 * "Compare" on a version opens an inline, virtualized `LineDiffView` backed by
 * `lib/artifacts/diff.computeDiff`, folded around the changes and sized to its
 * content up to a fixed cap. It compares with the current version by default;
 * the picker in its header compares with any other saved version instead,
 * always older → newer whichever side was picked first.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { History, Save, RotateCcw, GitCompareArrows } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { computeDiff, computeDiffStats } from "@/lib/artifacts"
import { LineDiffView } from "@/components/diff/line-diff-view"
import type { Artifact, ArtifactVersion } from "@/types"

interface PanelVersionHistoryProps {
  artifact: Artifact
  onVersionRestored?: () => void
}

/** The other side of a comparison: the live artifact, or a saved version. */
const CURRENT = "current"

interface CompareSide {
  label: string
  content: string
  /** Version number; the live artifact sorts after every saved version. */
  order: number
}

function InlineDiff({
  base,
  against,
  againstValue,
  options,
  onAgainstChange,
  pickerLabel,
}: {
  base: CompareSide
  against: CompareSide
  againstValue: string
  options: { value: string; label: string }[]
  onAgainstChange: (value: string) => void
  pickerLabel: string
}) {
  // Older on the left whichever side the reader picked first.
  const [older, newer] = base.order <= against.order ? [base, against] : [against, base]
  // Re-diffed only when a side changes, not on every re-render of the list
  // (the artifact store notifies on every edit while this panel is open).
  const diff = useMemo(
    () => computeDiff(older.content, newer.content),
    [older.content, newer.content]
  )
  const stats = useMemo(() => computeDiffStats(diff), [diff])

  return (
    <div className="overflow-hidden rounded-md border bg-card text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="shrink-0">{base.label}</span>
        <span aria-hidden>↔</span>
        <NativeSelect
          size="sm"
          value={againstValue}
          onChange={(e) => onAgainstChange(e.target.value)}
          aria-label={pickerLabel}
          className="h-7 text-[11px] sm:h-6"
          wrapperClassName="min-w-0 max-w-full"
          data-testid="version-compare-against"
        >
          {options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="ml-auto shrink-0 tabular-nums" data-testid="version-compare-stats">
          <span className="text-green-600 dark:text-green-400">+{stats.added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
        </span>
      </div>
      <LineDiffView
        lines={diff}
        maxHeight={240}
        aria-label={`${older.label} → ${newer.label}`}
        data-testid="version-inline-diff"
      />
    </div>
  )
}

export function PanelVersionHistory({ artifact, onVersionRestored }: PanelVersionHistoryProps) {
  const t = useTranslations("artifacts")
  const getArtifactVersions = useArtifactStore((state) => state.getArtifactVersions)
  const saveArtifactVersion = useArtifactStore((state) => state.saveArtifactVersion)
  const restoreArtifactVersion = useArtifactStore((state) => state.restoreArtifactVersion)

  const versions: ArtifactVersion[] = getArtifactVersions(artifact.id)
  const [diffVersionId, setDiffVersionId] = useState<string | null>(null)
  // What the open comparison compares against: the current version, or the
  // id of another saved version.
  const [against, setAgainst] = useState<string>(CURRENT)

  const diffVersion = diffVersionId ? versions.find((v) => v.id === diffVersionId) : null
  const currentSide: CompareSide = useMemo(
    () => ({
      label: `v${artifact.version} (${t("currentVersion")})`,
      content: artifact.content,
      order: Number.POSITIVE_INFINITY,
    }),
    [artifact.version, artifact.content, t]
  )
  const sideOf = useCallback(
    (version: ArtifactVersion): CompareSide => ({
      label: version.changeDescription
        ? `v${version.version} · ${version.changeDescription}`
        : `v${version.version}`,
      content: version.content,
      order: version.version,
    }),
    []
  )
  const againstVersion = against === CURRENT ? null : versions.find((v) => v.id === against)

  const handleSaveVersion = useCallback(() => {
    saveArtifactVersion(artifact.id, t("manualSave", { version: artifact.version }))
  }, [artifact.id, artifact.version, saveArtifactVersion, t])

  const handleRestoreVersion = useCallback(
    (versionId: string) => {
      restoreArtifactVersion(artifact.id, versionId, t("autoSaveBeforeRestore"))
      setDiffVersionId(null)
      onVersionRestored?.()
    },
    [artifact.id, restoreArtifactVersion, onVersionRestored, t]
  )

  const toggleDiff = useCallback((versionId: string) => {
    setDiffVersionId((prev) => (prev === versionId ? null : versionId))
    setAgainst(CURRENT)
  }, [])

  return (
    <div className="border-t bg-muted/30 max-h-[400px] overflow-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <h4 className="text-sm font-medium flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          {t("versionHistory")}
        </h4>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleSaveVersion}>
          <Save className="h-3 w-3 mr-1" />
          {t("saveVersion")}
        </Button>
      </div>
      {versions.length === 0 ? (
        <p className="text-xs text-muted-foreground px-4 py-3">{t("noVersions")}</p>
      ) : (
        <div className="divide-y">
          {versions.map((version) => (
            <div key={version.id}>
              <div className="flex items-center justify-between px-4 py-2 text-xs hover:bg-muted/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {version.changeDescription || `v${version.version}`}
                  </p>
                  <p className="text-muted-foreground">
                    {version.createdAt instanceof Date
                      ? version.createdAt.toLocaleString()
                      : new Date(version.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Button
                    variant={diffVersionId === version.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => toggleDiff(version.id)}
                    title={t("compareVersion")}
                    aria-label={t("compareVersion")}
                    aria-pressed={diffVersionId === version.id}
                  >
                    <GitCompareArrows className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => handleRestoreVersion(version.id)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    {t("restoreVersion")}
                  </Button>
                </div>
              </div>
              {diffVersionId === version.id && diffVersion && (
                <div className="px-4 pb-3">
                  <InlineDiff
                    base={sideOf(diffVersion)}
                    against={againstVersion ? sideOf(againstVersion) : currentSide}
                    againstValue={againstVersion ? againstVersion.id : CURRENT}
                    options={[
                      { value: CURRENT, label: currentSide.label },
                      ...versions
                        .filter((v) => v.id !== diffVersion.id)
                        .map((v) => ({ value: v.id, label: sideOf(v).label })),
                    ]}
                    onAgainstChange={setAgainst}
                    pickerLabel={t("compareAgainst")}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
