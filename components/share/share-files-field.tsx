"use client"

/**
 * The Files part of the share dialog (ADR-0222): what is picked, what it
 * expands to, and anything that keeps it from being shared as picked.
 *
 * Every refusal is shown, never applied silently: files the sensitive floor
 * withheld from a folder are counted, a file picked by name that looks like a
 * credential needs its own tick, paths that contribute nothing say why, and a
 * selection over the server's limits says which limit.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, Loader2Icon, PaperclipIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { ShareFileSelection } from "@/hooks/share/use-share-file-selection"
import type {
  ShareSelectionIssueReason,
  ShareSelectionLimitViolation,
} from "@/lib/share/file-selection"
import { formatBytes } from "@/lib/perf/backend/format"
import type { FileSpacePath } from "@/types/filespace"

import { ShareFilesPicker } from "./share-files-picker"

const ISSUE_KEY: Record<ShareSelectionIssueReason, string> = {
  "not-found": "issue.notFound",
  outside: "issue.outside",
  offline: "issue.offline",
  "no-backend": "issue.noBackend",
  "source-unavailable": "issue.sourceUnavailable",
}

export interface ShareFilesFieldProps {
  selection: ShareFileSelection
  selected: readonly FileSpacePath[]
  onToggle: (path: FileSpacePath, checked: boolean) => void
  confirmedSensitive: ReadonlySet<string>
  onConfirmSensitive: (path: FileSpacePath, confirmed: boolean) => void
  violations: readonly ShareSelectionLimitViolation[]
}

export function ShareFilesField({
  selection,
  selected,
  onToggle,
  confirmedSensitive,
  onConfirmSensitive,
  violations,
}: ShareFilesFieldProps) {
  const t = useTranslations("share.files")
  const [picking, setPicking] = useState(selected.length === 0)
  const { loaded, expanded, pending, failed } = selection
  const files = expanded?.files ?? []
  const sensitive = files.filter((file) => file.sensitive)
  const included = files.filter((file) => !file.sensitive || confirmedSensitive.has(file.path))
  const total = included.reduce((sum, file) => sum + file.size, 0)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs">
          <PaperclipIcon className="size-3.5" aria-hidden />
          {t("label")}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setPicking((open) => !open)}
          aria-expanded={picking}
        >
          {picking ? t("hidePicker") : t("choose")}
        </Button>
      </div>

      {selected.length > 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          {pending ? (
            <span className="inline-flex items-center gap-1">
              <Loader2Icon className="size-3 animate-spin" aria-hidden />
              {t("expanding")}
            </span>
          ) : (
            t("summary", { count: included.length, size: formatBytes(total) })
          )}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      )}

      {picking ? (
        loaded ? (
          <ShareFilesPicker
            space={loaded.space}
            dexie={loaded.dexie}
            selected={selected}
            onToggle={onToggle}
          />
        ) : loaded === undefined ? (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("conversationGone")}</p>
        )
      ) : null}

      {failed ? <p className="text-xs text-destructive">{t("expandFailed")}</p> : null}

      {expanded && expanded.skippedSensitive > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("skippedSensitive", { count: expanded.skippedSensitive })}
        </p>
      ) : null}
      {expanded?.truncated ? <p className="text-xs text-destructive">{t("truncated")}</p> : null}
      {expanded?.issues.map((issue) => (
        <p key={issue.path} className="text-xs text-muted-foreground">
          {t(ISSUE_KEY[issue.reason], { path: issue.path })}
        </p>
      ))}

      {sensitive.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <AlertTriangleIcon className="size-3.5 text-amber-600" aria-hidden />
            {t("sensitiveTitle")}
          </p>
          <p className="text-xs text-muted-foreground">{t("sensitiveBody")}</p>
          {sensitive.map((file) => (
            <label key={file.path} className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={confirmedSensitive.has(file.path)}
                onCheckedChange={(next) => onConfirmSensitive(file.path, next === true)}
                aria-label={t("includeSensitive", { path: file.path })}
              />
              <span className="truncate font-mono">{file.path}</span>
            </label>
          ))}
        </div>
      ) : null}

      {violations.map((violation) => (
        <p key={violationKey(violation)} className="text-xs text-destructive">
          {violation.kind === "too-many-files"
            ? t("limit.tooMany", { count: violation.count, max: violation.max })
            : violation.kind === "file-too-large"
              ? t("limit.fileTooLarge", { path: violation.path, max: formatBytes(violation.max) })
              : t("limit.totalTooLarge", { max: formatBytes(violation.max) })}
        </p>
      ))}
    </div>
  )
}

function violationKey(violation: ShareSelectionLimitViolation): string {
  return violation.kind === "file-too-large"
    ? `${violation.kind}:${violation.path}`
    : violation.kind
}
