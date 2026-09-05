"use client"

/**
 * Import issues from a file (spec 2026-09-06, Import).
 *
 * Paste or drop a CSV, JSON or Markdown task list, see what it parsed to,
 * pick the container (and optionally a cycle and a default status), and
 * create. The outcome is counted the way bulk actions are: created,
 * skipped as already imported, failed, so a re-import of the same file says
 * "0 created, 12 skipped" instead of duplicating twelve rows.
 */

import { UploadIcon } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { importIssues, type ImportIssuesOutcome } from "@/lib/issues/import/apply"
import {
  detectIssueImportFormat,
  ISSUE_IMPORT_FORMATS,
  parseIssueImport,
  type IssueImportFormat,
  type IssueImportParse,
} from "@/lib/issues/import/parse"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import type { IssueCycle, IssueProject, IssueStatus } from "@/types/issues"
import { ISSUE_STATUSES } from "@/types/issues"

const PREVIEW_ROWS = 8

/** `Blob.text()` where the runtime has it, `FileReader` where it does not (jsdom). */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsText(file)
  })
}
/** `Select` cannot hold an empty string. */
const NO_CYCLE = "__none__"

export interface ImportIssuesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Owning workspace id. */
  projectId: string
  projects: readonly IssueProject[]
  cycles?: readonly IssueCycle[]
  /** Preselected container, e.g. the one the rail is filtered to. */
  initialProjectId?: string
  onImported?: (outcome: ImportIssuesOutcome) => void
}

export function ImportIssuesDialog({
  open,
  onOpenChange,
  projectId,
  projects,
  cycles = [],
  initialProjectId,
  onImported,
}: ImportIssuesDialogProps) {
  const t = useTranslations("issues")
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [format, setFormat] = useState<IssueImportFormat | "auto">("auto")
  const [issueProjectId, setIssueProjectId] = useState("")
  const [status, setStatus] = useState<IssueStatus | "">("")
  const [cycleId, setCycleId] = useState(NO_CYCLE)
  const [busy, setBusy] = useState(false)

  const resolvedFormat: IssueImportFormat =
    format === "auto" ? detectIssueImportFormat(text, fileName ?? undefined) : format
  const selectedProjectId = issueProjectId || initialProjectId || projects[0]?.id || ""

  const parsed = useMemo<{ result: IssueImportParse | null; error: string | null }>(() => {
    if (!text.trim()) return { result: null, error: null }
    try {
      return { result: parseIssueImport(resolvedFormat, text), error: null }
    } catch (cause) {
      return { result: null, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [text, resolvedFormat])

  const rows = parsed.result?.rows ?? []
  const canSubmit = !busy && rows.length > 0 && Boolean(selectedProjectId)

  function close() {
    setText("")
    setFileName(null)
    setFormat("auto")
    setIssueProjectId("")
    setStatus("")
    setCycleId(NO_CYCLE)
    onOpenChange(false)
  }

  async function handleFile(file: File) {
    setFileName(file.name)
    setText(await readFileText(file))
  }

  async function submit() {
    if (!parsed.result) return
    setBusy(true)
    try {
      const outcome = await importIssues({
        projectId,
        issueProjectId: selectedProjectId,
        format: parsed.result.format,
        rows: parsed.result.rows,
        ...(status ? { defaultStatus: status } : {}),
        ...(cycleId !== NO_CYCLE ? { cycleId } : {}),
        by: { kind: "human" },
      })
      if (outcome.failed > 0) {
        toast.error(
          t("import.failed", {
            created: outcome.created,
            failed: outcome.failed,
            reason: outcome.errors[0]?.error ?? "",
          })
        )
      } else {
        toast.success(t("import.done", { created: outcome.created, skipped: outcome.skipped }))
      }
      onImported?.(outcome)
      close()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else close()
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="import-issues-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const file = event.dataTransfer.files[0]
              if (file) void handleFile(file)
            }}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center text-sm"
            data-testid="import-issues-drop"
          >
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,.json,.md,.markdown,text/csv,application/json,text/markdown"
              className="hidden"
              aria-label={t("import.browse")}
              data-testid="import-issues-file"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
                event.target.value = ""
              }}
            />
            <div className="flex items-center gap-2 text-muted-foreground">
              <UploadIcon className="size-4" />
              <span>{fileName ?? t("import.drop")}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              {t("import.browse")}
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-issues-text">{t("import.pasteLabel")}</Label>
            <Textarea
              id="import-issues-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              placeholder={t("import.pastePlaceholder")}
              className="font-mono text-xs"
              data-testid="import-issues-text"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-issues-format">{t("import.format")}</Label>
              <Select
                value={format}
                onValueChange={(value) => setFormat(value as IssueImportFormat | "auto")}
              >
                <SelectTrigger id="import-issues-format" data-testid="import-issues-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {t("import.formatAuto", { format: t(`import.formats.${resolvedFormat}`) })}
                  </SelectItem>
                  {ISSUE_IMPORT_FORMATS.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {t(`import.formats.${candidate}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-issues-project">{t("create.projectLabel")}</Label>
              <Select value={selectedProjectId} onValueChange={setIssueProjectId}>
                <SelectTrigger id="import-issues-project" data-testid="import-issues-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name} ({project.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-issues-status">{t("import.defaultStatus")}</Label>
              <Select
                value={status || "__keep__"}
                onValueChange={(value) =>
                  setStatus(value === "__keep__" ? "" : (value as IssueStatus))
                }
              >
                <SelectTrigger id="import-issues-status" data-testid="import-issues-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__keep__">{t("import.defaultStatusKeep")}</SelectItem>
                  {ISSUE_STATUSES.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {t(`status.${candidate}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {cycles.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="import-issues-cycle">{t("planning.cycle")}</Label>
                <Select value={cycleId} onValueChange={setCycleId}>
                  <SelectTrigger id="import-issues-cycle" data-testid="import-issues-cycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CYCLE}>{t("planning.noCycle")}</SelectItem>
                    {cycles.map((cycle) => (
                      <SelectItem key={cycle.id} value={cycle.id}>
                        {cycle.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {parsed.error ? (
            <p className="text-sm text-destructive" data-testid="import-issues-error">
              {parsed.error}
            </p>
          ) : null}

          {parsed.result ? (
            <div className="flex flex-col gap-1.5" data-testid="import-issues-preview">
              <p className="text-xs text-muted-foreground">
                {t("import.preview", {
                  count: rows.length,
                  skipped: parsed.result.skipped.length,
                })}
              </p>
              {rows.length > 0 ? (
                <ul className="flex flex-col divide-y rounded-md border text-xs">
                  {rows.slice(0, PREVIEW_ROWS).map((row) => (
                    <li key={row.externalId} className="flex items-center gap-2 px-2 py-1.5">
                      <IssueStatusIcon status={(row.status ?? status) || "backlog"} />
                      {row.priority ? <IssuePriorityIcon priority={row.priority} /> : null}
                      {row.parentExternalId ? (
                        <span aria-hidden className="text-muted-foreground">
                          ↳
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      {row.labels.length > 0 ? (
                        <span className="truncate text-muted-foreground">
                          {row.labels.join(", ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {rows.length > PREVIEW_ROWS ? (
                    <li className="px-2 py-1.5 text-muted-foreground">
                      {t("import.more", { count: rows.length - PREVIEW_ROWS })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("create.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit} data-testid="import-issues-submit">
            {t("import.submit", { count: rows.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
