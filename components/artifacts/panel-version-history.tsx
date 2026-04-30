"use client"

/**
 * PanelVersionHistory - Version history panel for ArtifactPanel.
 *
 * cognia-next ships a simpler diff view than upstream Cognia: an inline
 * `<pre>` block backed by `lib/artifacts/diff.computeDiff` — no separate
 * version-diff-view component.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { History, Save, RotateCcw, GitCompareArrows } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { computeDiff, computeDiffStats } from "@/lib/artifacts"
import { cn } from "@/lib/utils"
import type { Artifact, ArtifactVersion } from "@/types"

interface PanelVersionHistoryProps {
  artifact: Artifact
  onVersionRestored?: () => void
}

function InlineDiff({
  oldContent,
  newContent,
  oldLabel,
  newLabel,
}: {
  oldContent: string
  newContent: string
  oldLabel: string
  newLabel: string
}) {
  const diff = computeDiff(oldContent, newContent)
  const stats = computeDiffStats(diff)

  return (
    <div className="rounded-md border bg-card text-xs">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {oldLabel} → {newLabel}
        </span>
        <span>
          <span className="text-green-600 dark:text-green-400">+{stats.added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
        </span>
      </div>
      <pre className="max-h-[240px] overflow-auto p-2 font-mono">
        {diff.map((line, i) => (
          <div
            key={i}
            className={cn(
              "px-1",
              line.type === "added" && "bg-green-500/10 text-green-700 dark:text-green-300",
              line.type === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300"
            )}
          >
            <span className="select-none opacity-50">
              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
            </span>{" "}
            {line.content}
          </div>
        ))}
      </pre>
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

  const diffVersion = diffVersionId ? versions.find((v) => v.id === diffVersionId) : null

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
                    title={t("compareWithCurrent")}
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
                    oldContent={diffVersion.content}
                    newContent={artifact.content}
                    oldLabel={`v${diffVersion.version}`}
                    newLabel={`v${artifact.version} (${t("currentVersion")})`}
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
