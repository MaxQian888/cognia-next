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
  ShareFileCandidate,
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

      <SensitiveConfirmations
        files={sensitive}
        confirmed={confirmedSensitive}
        onConfirm={onConfirmSensitive}
      />
      <LimitViolations violations={violations} />
    </div>
  )
}

/** Credential-like files, each shared only once the person ticks it. */
function SensitiveConfirmations({
  files,
  confirmed,
  onConfirm,
}: {
  files: readonly ShareFileCandidate[]
  confirmed: ReadonlySet<string>
  onConfirm: (path: FileSpacePath, confirmed: boolean) => void
}) {
  const t = useTranslations("share.files")
  if (files.length === 0) return null
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <AlertTriangleIcon className="size-3.5 text-amber-600" aria-hidden />
        {t("sensitiveTitle")}
      </p>
      <p className="text-xs text-muted-foreground">{t("sensitiveBody")}</p>
      {files.map((file) => (
        <label key={file.path} className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={confirmed.has(file.path)}
            onCheckedChange={(next) => onConfirm(file.path, next === true)}
            aria-label={t("includeSensitive", { path: file.path })}
          />
          <span className="truncate font-mono">{file.path}</span>
        </label>
      ))}
    </div>
  )
}

/** Which of the server's limits the files exceed. */
function LimitViolations({ violations }: { violations: readonly ShareSelectionLimitViolation[] }) {
  const t = useTranslations("share.files")
  return violations.map((violation) => (
    <p key={violationKey(violation)} className="text-xs text-destructive">
      {violation.kind === "too-many-files"
        ? t("limit.tooMany", { count: violation.count, max: violation.max })
        : violation.kind === "file-too-large"
          ? t("limit.fileTooLarge", { path: violation.path, max: formatBytes(violation.max) })
          : t("limit.totalTooLarge", { max: formatBytes(violation.max) })}
    </p>
  ))
}

/** Files picked somewhere other than a conversation's FileSpace (the Files page, ADR-0223). */
export interface ShareLinkPickedFiles {
  /** `undefined` while they are being read. */
  files: ShareFileCandidate[] | undefined
  /** Names of picked items with nothing stored to carry. */
  unavailable?: string[]
  /** Reading them failed. */
  failed?: boolean
}

export interface SharePickedFilesFieldProps {
  picked: ShareLinkPickedFiles
  confirmedSensitive: ReadonlySet<string>
  onConfirmSensitive: (path: FileSpacePath, confirmed: boolean) => void
  violations: readonly ShareSelectionLimitViolation[]
}

/**
 * Files picked before the dialog opened — the Files page's selection
 * (ADR-0223). There is nothing to choose here; the field says what the link
 * will carry, what it cannot, and asks for the same per-file opt-in for
 * anything that looks like a credential.
 */
export function SharePickedFilesField({
  picked,
  confirmedSensitive,
  onConfirmSensitive,
  violations,
}: SharePickedFilesFieldProps) {
  const t = useTranslations("share.files")
  const files = picked.files ?? []
  const sensitive = files.filter((file) => file.sensitive)
  const included = files.filter((file) => !file.sensitive || confirmedSensitive.has(file.path))
  const total = included.reduce((sum, file) => sum + file.size, 0)

  return (
    <div className="space-y-2" data-testid="share-picked-files">
      <Label className="flex items-center gap-1.5 text-xs">
        <PaperclipIcon className="size-3.5" aria-hidden />
        {t("label")}
      </Label>
      <p className="text-xs text-muted-foreground" role="status">
        {picked.failed ? null : picked.files === undefined ? (
          <span className="inline-flex items-center gap-1">
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
            {t("picked.reading")}
          </span>
        ) : (
          t("summary", { count: included.length, size: formatBytes(total) })
        )}
      </p>
      {picked.failed ? <p className="text-xs text-destructive">{t("picked.readFailed")}</p> : null}
      {files.length > 0 ? (
        <ul className="max-h-40 space-y-0.5 overflow-auto rounded-md border p-2">
          {files.map((file) => (
            <li key={file.path} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-mono" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {picked.unavailable?.map((name) => (
        <p key={name} className="text-xs text-muted-foreground">
          {t("picked.missing", { name })}
        </p>
      ))}
      <SensitiveConfirmations
        files={sensitive}
        confirmed={confirmedSensitive}
        onConfirm={onConfirmSensitive}
      />
      <LimitViolations violations={violations} />
    </div>
  )
}

function violationKey(violation: ShareSelectionLimitViolation): string {
  return violation.kind === "file-too-large"
    ? `${violation.kind}:${violation.path}`
    : violation.kind
}
