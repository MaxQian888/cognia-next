"use client"

/**
 * Dataset version snapshots (Approach A). Lists immutable snapshots
 * newest-first with their short content hash + case count, and lets the user
 * tag a version (e.g. "prod"). Runs pin to a `datasetVersionId`, so tagged
 * versions are the stable comparison anchors.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { TagIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { tagVersion } from "@/lib/db/eval-dataset-versions"
import { useEvalDatasetVersions } from "@/hooks/eval/use-eval-data"
import { snapshotCaseCount } from "@/types/eval/version"

export function VersionHistory({ datasetId }: { datasetId: string }) {
  const t = useTranslations("eval")
  const versions = useEvalDatasetVersions(datasetId)
  const [tagging, setTagging] = useState<string | null>(null)
  const [tag, setTag] = useState("")

  const applyTag = async (id: string) => {
    await tagVersion(id, tag.trim())
    setTagging(null)
    setTag("")
  }

  if (versions.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("versions.empty")}</p>
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="version-history">
      {versions.map((v) => (
        <li
          key={v.id}
          className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{t("versions.version", { version: v.version })}</Badge>
            <span className="text-muted-foreground font-mono text-xs">
              {v.casesHash.slice(0, 8)}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("versions.cases", { count: snapshotCaseCount(v) })}
            </span>
            {v.tag && <Badge>{v.tag}</Badge>}
          </div>
          {tagging === v.id ? (
            <div className="flex items-center gap-1">
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
            </div>
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
        </li>
      ))}
    </ul>
  )
}
