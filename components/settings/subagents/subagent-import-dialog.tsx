"use client"

/**
 * SubagentImportDialog — three-step wizard that imports external subagent
 * configurations (Claude Code / Codex CLI / Cursor / Cline / generic
 * markdown) into either the SubAgentTemplate registry or the Character
 * library. Triggered from the Subagents settings tab toolbar.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, FolderOpenIcon, FileTextIcon, AlertCircleIcon } from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

import { isTauri } from "@/lib/tauri"
import {
  SUBAGENT_SOURCE_ADAPTERS,
  detectSource,
  getSubagentAdapter,
  type ImportFile,
  type ImportMergeStrategy,
  type ImportTarget,
  type ParseFailure,
  type SubagentImportDraft,
  type SubagentSourceId,
} from "@/lib/claude/subagent-importers"
import { applySubagentImport } from "@/lib/claude/subagent-importers/apply"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.subagents.import")

type Stage = "source" | "files" | "review"
type SourceChoice = SubagentSourceId | "auto"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful apply so the parent can refresh. */
  onImported?: () => void
}

const SOURCE_CHOICES: { id: SourceChoice; labelKey: string }[] = [
  { id: "auto", labelKey: "auto" },
  ...SUBAGENT_SOURCE_ADAPTERS.map((a) => ({ id: a.id, labelKey: a.labelKey })),
]

/** Read all picked files via the Tauri filesystem plugin (recursive). */
async function readFilesFromTauri(): Promise<ImportFile[]> {
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog")
  const { readTextFile, readDir } = await import("@tauri-apps/plugin-fs")

  const picked = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdc", "yaml", "yml"] }],
  })
  const paths = !picked ? [] : Array.isArray(picked) ? picked : [picked]
  if (paths.length === 0) {
    // Try directory mode as a second option.
    const dir = await openDialog({ multiple: false, directory: true })
    if (typeof dir === "string") {
      const entries = await readDir(dir)
      for (const e of entries) {
        if (e.name && /\.(md|markdown|mdc|yaml|yml)$/i.test(e.name)) {
          paths.push(`${dir}/${e.name}`)
        }
      }
    }
  }

  const out: ImportFile[] = []
  for (const path of paths) {
    try {
      const content = await readTextFile(path)
      const filename = path.split(/[\\/]/).pop() ?? path
      // Convert absolute path to a relative-ish hint for adapter detection.
      // We keep the last 4 path segments — enough for path-keyed detection
      // (".claude/agents/foo.md") without leaking a long absolute prefix.
      const parts = path.split(/[\\/]/)
      const tail = parts.slice(Math.max(0, parts.length - 4)).join("/")
      out.push({ filename, sourcePath: tail, content })
    } catch (err) {
      log.warn("read_failed", {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

/** Convert a browser FileList to ImportFile[]. */
async function readFilesFromBrowser(list: FileList): Promise<ImportFile[]> {
  const out: ImportFile[] = []
  for (const f of Array.from(list)) {
    const content = await f.text()
    // webkitRelativePath captures the directory prefix when the user picks
    // a folder — exactly what our adapters need to detect ".claude/agents/".
    const sourcePath = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    out.push({ filename: f.name, sourcePath, content })
  }
  return out
}

function parseWith(
  sourceChoice: SourceChoice,
  files: ImportFile[]
): { drafts: SubagentImportDraft[]; errors: ParseFailure[]; resolvedSource: SubagentSourceId } {
  const resolved =
    sourceChoice === "auto" ? (detectSource({ files }) ?? "generic-md") : sourceChoice
  const adapter = getSubagentAdapter(resolved)
  const result = adapter.parse({ files })
  return { ...result, resolvedSource: resolved }
}

export function SubagentImportDialog({ open, onOpenChange, onImported }: Props) {
  const t = useTranslations("settings.subagents.import")
  const tCommon = useTranslations("common")

  const [stage, setStage] = useState<Stage>("source")
  const [sourceChoice, setSourceChoice] = useState<SourceChoice>("auto")
  const [resolvedSource, setResolvedSource] = useState<SubagentSourceId | null>(null)
  const [drafts, setDrafts] = useState<SubagentImportDraft[]>([])
  const [parseErrors, setParseErrors] = useState<ParseFailure[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<ImportTarget>("subagent-template")
  const [strategy, setStrategy] = useState<ImportMergeStrategy>("skip")
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setStage("source")
    setSourceChoice("auto")
    setResolvedSource(null)
    setDrafts([])
    setParseErrors([])
    setSelected(new Set())
    setTarget("subagent-template")
    setStrategy("skip")
    setBusy(false)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset()
      onOpenChange(next)
    },
    [onOpenChange, reset]
  )

  const handlePickFiles = useCallback(async () => {
    setBusy(true)
    try {
      const picked = isTauri() ? await readFilesFromTauri() : []
      if (picked.length === 0) {
        // Web mode handled via the <input> element below; if Tauri picker
        // returned nothing, we just stay on this step.
        return
      }
      const r = parseWith(sourceChoice, picked)
      setDrafts(r.drafts)
      setParseErrors(r.errors)
      setResolvedSource(r.resolvedSource)
      setSelected(new Set(r.drafts.map((d) => d.sourceKey)))
      setStage("review")
    } catch (err) {
      log.error("pick_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      toast.error(t("errors.pickFailed"))
    } finally {
      setBusy(false)
    }
  }, [sourceChoice, t])

  const handleBrowserFiles = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files
      if (!list || list.length === 0) return
      setBusy(true)
      try {
        const picked = await readFilesFromBrowser(list)
        const r = parseWith(sourceChoice, picked)
        setDrafts(r.drafts)
        setParseErrors(r.errors)
        setResolvedSource(r.resolvedSource)
        setSelected(new Set(r.drafts.map((d) => d.sourceKey)))
        setStage("review")
      } finally {
        setBusy(false)
        // Allow re-selecting the same files later.
        e.target.value = ""
      }
    },
    [sourceChoice]
  )

  const toggleDraft = useCallback((sourceKey: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourceKey)) next.delete(sourceKey)
      else next.add(sourceKey)
      return next
    })
  }, [])

  const handleApply = useCallback(async () => {
    setBusy(true)
    try {
      const chosen = drafts.filter((d) => selected.has(d.sourceKey))
      const r = await applySubagentImport({ drafts: chosen, target, strategy })
      log.info("apply_done", { ...r, target, strategy, count: chosen.length })
      toast.success(
        t("summary", {
          imported: r.imported,
          skipped: r.skipped,
          overwritten: r.overwritten,
          failed: r.failed.length,
        })
      )
      if (r.failed.length > 0) {
        toast.warning(r.failed.map((f) => `${f.name}: ${f.error}`).join("; "))
      }
      onImported?.()
      handleOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [drafts, selected, target, strategy, t, onImported, handleOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="subagent-import-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {stage === "source" && (
          <div className="space-y-3" data-testid="subagent-import-step-source">
            <Label className="text-sm font-medium">{t("step1Title")}</Label>
            <RadioGroup
              value={sourceChoice}
              onValueChange={(v) => setSourceChoice(v as SourceChoice)}
              className="grid gap-2"
            >
              {SOURCE_CHOICES.map((c) => (
                <Label
                  key={c.id}
                  className="flex items-center gap-2 rounded border p-2 hover:bg-accent cursor-pointer"
                  htmlFor={`subagent-import-src-${c.id}`}
                >
                  <RadioGroupItem value={c.id} id={`subagent-import-src-${c.id}`} />
                  <span className="text-sm">{t(`sources.${c.labelKey}`)}</span>
                </Label>
              ))}
            </RadioGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
                {tCommon("cancel")}
              </Button>
              <Button onClick={() => setStage("files")} data-testid="subagent-import-next">
                {tCommon("next")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === "files" && (
          <div className="space-y-3" data-testid="subagent-import-step-files">
            <Label className="text-sm font-medium">{t("step2Title")}</Label>

            {isTauri() ? (
              <div className="rounded border border-dashed p-6 text-center">
                <FolderOpenIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-3">{t("tauriPickHint")}</p>
                <Button
                  onClick={handlePickFiles}
                  disabled={busy}
                  data-testid="subagent-import-tauri-pick"
                >
                  {t("pickFiles")}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <label
                  htmlFor="subagent-import-file-input"
                  className="block rounded border border-dashed p-6 text-center cursor-pointer hover:bg-accent"
                >
                  <FileTextIcon className="mx-auto mb-2 size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground mb-1">{t("webPickHint")}</p>
                  <p className="text-xs text-muted-foreground">{t("webPickFormats")}</p>
                </label>
                <input
                  id="subagent-import-file-input"
                  data-testid="subagent-import-file-input"
                  type="file"
                  multiple
                  accept=".md,.markdown,.mdc,.yaml,.yml"
                  className="hidden"
                  onChange={handleBrowserFiles}
                />
                <input
                  data-testid="subagent-import-folder-input"
                  type="file"
                  multiple
                  // @ts-expect-error webkitdirectory is a non-standard but
                  // widely-supported attribute.
                  webkitdirectory=""
                  directory=""
                  className="hidden"
                  onChange={handleBrowserFiles}
                />
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setStage("source")} disabled={busy}>
                {tCommon("back")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {stage === "review" && (
          <div className="space-y-3" data-testid="subagent-import-step-review">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">{t("step3Title")}</Label>
              {resolvedSource && (
                <Badge variant="secondary" className="text-xs">
                  {t(`sources.${resolvedSource}`)}
                </Badge>
              )}
            </div>

            {parseErrors.length > 0 && (
              <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs space-y-1">
                <div className="flex items-center gap-1 font-medium text-destructive">
                  <AlertCircleIcon className="size-3.5" />
                  {t("warningsHeader", { count: parseErrors.length })}
                </div>
                {parseErrors.map((e, i) => (
                  <div key={i} className="text-muted-foreground">
                    {e.error}
                  </div>
                ))}
              </div>
            )}

            <ScrollArea className="h-56 rounded border">
              <div className="divide-y">
                {drafts.length === 0 && (
                  <div className="p-4 text-sm text-muted-foreground text-center">
                    {t("noDrafts")}
                  </div>
                )}
                {drafts.map((d) => (
                  <label
                    key={d.sourceKey}
                    className="flex items-start gap-2 p-2 hover:bg-accent cursor-pointer"
                  >
                    <Checkbox
                      checked={selected.has(d.sourceKey)}
                      onCheckedChange={() => toggleDraft(d.sourceKey)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="text-sm font-medium truncate">{d.name}</div>
                      {d.description && (
                        <div className="text-xs text-muted-foreground truncate">
                          {d.description}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {d.tools?.map((tool) => (
                          <Badge key={tool} variant="outline" className="text-[10px]">
                            {tool}
                          </Badge>
                        ))}
                        {d.model && (
                          <Badge variant="outline" className="text-[10px]">
                            {d.model}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {d.sourceFile}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("targetLabel")}</Label>
                <RadioGroup value={target} onValueChange={(v) => setTarget(v as ImportTarget)}>
                  <Label
                    htmlFor="target-template"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem id="target-template" value="subagent-template" />
                    {t("target.subagentTemplate")}
                  </Label>
                  <Label
                    htmlFor="target-character"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem id="target-character" value="character" />
                    {t("target.character")}
                  </Label>
                </RadioGroup>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{t("strategyLabel")}</Label>
                <RadioGroup
                  value={strategy}
                  onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}
                >
                  <Label
                    htmlFor="strategy-skip"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem id="strategy-skip" value="skip" />
                    {t("strategy.skip")}
                  </Label>
                  <Label
                    htmlFor="strategy-overwrite"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem id="strategy-overwrite" value="overwrite" />
                    {t("strategy.overwrite")}
                  </Label>
                  <Label
                    htmlFor="strategy-duplicate"
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem id="strategy-duplicate" value="duplicate" />
                    {t("strategy.duplicate")}
                  </Label>
                </RadioGroup>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStage("files")} disabled={busy}>
                {tCommon("back")}
              </Button>
              <Button
                onClick={handleApply}
                disabled={busy || selected.size === 0}
                data-testid="subagent-import-apply"
              >
                <DownloadIcon className="mr-2 size-4" />
                {t("applyButton", { count: selected.size })}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default SubagentImportDialog
