"use client"

/**
 * Portable prompt profiles (ADR-0236 §4 "Portability", R2): export the
 * published overrides as one JSON file, import one with a preview of what
 * each entry would do. Workspace, agent and session entries name targets of
 * the machine they came from, so each is mapped to a local target explicitly;
 * an id that exists here is offered as the default mapping, never applied
 * without the preview. Imported text is validated against this build's
 * definitions, and only the entries the user ticks are published.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { DownloadIcon, FileUpIcon } from "lucide-react"
import { downloadBlob } from "@cognia/plugin-sdk/api/download"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  applyPromptProfileImport,
  exportPromptProfile,
  importTargetKey,
  parsePromptProfile,
  previewPromptProfileImport,
  PromptProfileFormatError,
  serializePromptProfile,
  type PromptImportPreviewEntry,
  type PromptProfileV1,
} from "@/lib/prompts/profile"
import { PROMPT_SCOPE_SPECIFICITY, type PromptScope } from "@/lib/prompts/types"
import { usePromptTargetOptions } from "./prompt-target-picker"
import { usePromptLabels } from "./use-prompt-labels"

const APPLICABLE = new Set(["new", "replace"])
/** Select value for an unmapped target. */
const UNMAPPED = "__unmapped__"

export interface PromptProfileDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

export function PromptProfileDialog({ open, onOpenChange }: PromptProfileDialogProps) {
  const { t } = usePromptLabels()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("profile.title")}</DialogTitle>
          <DialogDescription>{t("profile.description")}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="export">
          <TabsList>
            <TabsTrigger value="export">{t("profile.exportTab")}</TabsTrigger>
            <TabsTrigger value="import">{t("profile.importTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="export">
            <ExportPane />
          </TabsContent>
          <TabsContent value="import">
            <ImportPane onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function ExportPane() {
  const { t } = usePromptLabels()
  const [scopes, setScopes] = useState<Set<PromptScope>>(() => new Set(PROMPT_SCOPE_SPECIFICITY))
  const [busy, setBusy] = useState(false)

  const exportNow = async () => {
    setBusy(true)
    try {
      const profile = await exportPromptProfile({ scopes: [...scopes] })
      if (profile.entries.length === 0) {
        toast.info(t("profile.nothingToExport"))
        return
      }
      const stamp = profile.exportedAt.slice(0, 10)
      downloadBlob(
        `cognia-prompts-${stamp}.json`,
        new Blob([serializePromptProfile(profile)], { type: "application/json" })
      )
      toast.success(t("profile.exported", { count: profile.entries.length }))
    } catch (error) {
      toast.error(
        t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-muted-foreground">{t("profile.exportHint")}</p>
      <div className="flex flex-wrap gap-4">
        {PROMPT_SCOPE_SPECIFICITY.map((scope) => (
          <Label key={scope} className="flex items-center gap-2 text-xs font-normal">
            <Checkbox
              checked={scopes.has(scope)}
              onCheckedChange={(checked) =>
                setScopes((previous) => {
                  const next = new Set(previous)
                  if (checked === true) next.add(scope)
                  else next.delete(scope)
                  return next
                })
              }
            />
            {t(`scope.${scope}`)}
          </Label>
        ))}
      </div>
      <Button
        size="sm"
        className="gap-1"
        disabled={busy || scopes.size === 0}
        onClick={() => void exportNow()}
      >
        <DownloadIcon className="size-3.5" />
        {t("profile.exportAction")}
      </Button>
    </div>
  )
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"))
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.readAsText(file)
  })
}

function ImportPane({ onDone }: { onDone(): void }) {
  const { t, entryTitle } = usePromptLabels()
  const fileRef = useRef<HTMLInputElement>(null)
  const [profile, setProfile] = useState<PromptProfileV1 | null>(null)
  const [targetMap, setTargetMap] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<PromptImportPreviewEntry[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    void previewPromptProfileImport(profile, targetMap).then((next) => {
      if (cancelled) return
      setPreview(next)
      setSelected(
        new Set(next.filter((item) => APPLICABLE.has(item.status)).map((item) => item.index))
      )
    })
    return () => {
      cancelled = true
    }
  }, [profile, targetMap])

  /** Each scoped source target the profile names, once. */
  const sourceTargets = useMemo(() => {
    const seen = new Map<string, { scope: PromptScope; targetId: string }>()
    for (const entry of profile?.entries ?? []) {
      if (entry.scope === "account") continue
      seen.set(importTargetKey(entry), { scope: entry.scope, targetId: entry.targetId })
    }
    return [...seen.entries()]
  }, [profile])

  const pick = async (file: File) => {
    try {
      const parsed = parsePromptProfile(await readFileText(file))
      setTargetMap({})
      setPreview(null)
      setProfile(parsed)
    } catch (error) {
      toast.error(
        error instanceof PromptProfileFormatError
          ? t("profile.invalidFile", { reason: error.message })
          : t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
      )
    }
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const result = await applyPromptProfileImport(preview, selected)
      if (result.conflicted.length > 0) {
        toast.warning(
          t("profile.appliedWithConflicts", {
            applied: result.applied,
            conflicted: result.conflicted.length,
          })
        )
      } else {
        toast.success(t("profile.applied", { count: result.applied }))
      }
      onDone()
    } catch (error) {
      toast.error(
        t("toast.failed", { message: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <Input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label={t("profile.chooseFile")}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void pick(file)
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="gap-1"
        onClick={() => fileRef.current?.click()}
      >
        <FileUpIcon className="size-3.5" />
        {t("profile.chooseFile")}
      </Button>

      {sourceTargets.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">{t("profile.mapTitle")}</h4>
          <p className="text-[11px] text-muted-foreground">{t("profile.mapHint")}</p>
          {sourceTargets.map(([key, source]) => (
            <TargetMapRow
              key={key}
              scope={source.scope}
              sourceId={source.targetId}
              value={targetMap[key]}
              onChange={(value) =>
                setTargetMap((previous) => {
                  const next = { ...previous }
                  if (value) next[key] = value
                  else delete next[key]
                  return next
                })
              }
            />
          ))}
        </section>
      ) : null}

      {preview ? (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">
            {t("profile.previewTitle", { count: preview.length })}
          </h4>
          <ul className="divide-y rounded-md border" data-testid="prompt-import-preview">
            {preview.map((item) => {
              const applicable = APPLICABLE.has(item.status)
              return (
                <li key={item.index} className="flex items-start gap-2 px-3 py-2">
                  <Checkbox
                    className="mt-0.5"
                    disabled={!applicable}
                    checked={selected.has(item.index)}
                    aria-label={entryTitle(item.entry.promptId)}
                    onCheckedChange={(checked) =>
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (checked === true) next.add(item.index)
                        else next.delete(item.index)
                        return next
                      })
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{entryTitle(item.entry.promptId)}</span>
                      <Badge variant={applicable ? "secondary" : "outline"} className="text-[10px]">
                        {t(`profile.status.${item.status}`)}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {t(`scope.${item.entry.scope}`)}
                      </Badge>
                      {item.upstreamChanged ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-400"
                        >
                          {t("profile.upstreamChanged")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {item.entry.promptId}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
          <DialogFooter>
            <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void apply()}>
              {t("profile.applyAction", { count: selected.size })}
            </Button>
          </DialogFooter>
        </section>
      ) : null}
    </div>
  )
}

function TargetMapRow({
  scope,
  sourceId,
  value,
  onChange,
}: {
  scope: PromptScope
  sourceId: string
  value: string | undefined
  onChange(value: string | undefined): void
}) {
  const { t } = usePromptLabels()
  const options = usePromptTargetOptions(scope)
  // The same id here is the obvious mapping (an export from this machine);
  // it is offered, and still shown in the preview before anything applies.
  const local = options?.some((option) => option.id === sourceId)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched && value === undefined && local) onChange(sourceId)
  }, [local, onChange, sourceId, touched, value])

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline" className="text-[10px]">
        {t(`scope.${scope}`)}
      </Badge>
      <code className="max-w-[200px] truncate font-mono text-[11px]" title={sourceId}>
        {sourceId}
      </code>
      <span className="text-muted-foreground">→</span>
      <Select
        value={value ?? UNMAPPED}
        onValueChange={(next) => {
          setTouched(true)
          onChange(next === UNMAPPED ? undefined : next)
        }}
      >
        <SelectTrigger
          className="h-7 min-w-[200px] text-xs"
          aria-label={t("profile.mapTarget", { id: sourceId })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNMAPPED} className="text-xs">
            {t("profile.skipTarget")}
          </SelectItem>
          {(options ?? []).map((option) => (
            <SelectItem key={option.id} value={option.id} className="text-xs">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
