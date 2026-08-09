"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, CheckCircle2Icon, Loader2Icon, RefreshCwIcon } from "lucide-react"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import {
  applyMigration,
  buildMigrationPreview,
  MIGRATION_ARTIFACTS,
  probeVendors,
  type MigrationArtifact,
  type MigrationPreview,
  type MigrationProgress,
  type MigrationResult,
  type MigrationVendor,
  type MigrationVendorProbe,
} from "@/lib/agent-migration"
import type { SettingsImportMergeStrategy } from "@/lib/settings-import"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

type Step = "vendor" | "artifacts" | "preview" | "result"
type MigrationErrorKey = "errors.scanFailed" | "errors.previewFailed" | "errors.importFailed"

export interface AgentMigrationDialogProps {
  trigger: React.ReactNode
}

export function AgentMigrationDialog({ trigger }: AgentMigrationDialogProps) {
  const t = useTranslations("agentMigration")
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("vendor")
  const [probes, setProbes] = useState<MigrationVendorProbe[]>([])
  const [vendor, setVendor] = useState<MigrationVendor | null>(null)
  const [selected, setSelected] = useState<Set<MigrationArtifact>>(
    () => new Set(MIGRATION_ARTIFACTS)
  )
  const [strategy, setStrategy] = useState<SettingsImportMergeStrategy>("skip")
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<MigrationErrorKey | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId)
  )
  const cwd = activeProject ? primaryRootOf(activeProject)?.path : undefined
  const selectedArtifacts = useMemo(
    () => MIGRATION_ARTIFACTS.filter((artifact) => selected.has(artifact)),
    [selected]
  )

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStep("vendor")
    setProbes([])
    setVendor(null)
    setSelected(new Set(MIGRATION_ARTIFACTS))
    setStrategy("skip")
    setPreview(null)
    setResult(null)
    setProgress(null)
    setBusy(false)
    setError(null)
  }, [])

  const scan = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await probeVendors()
      setProbes(next)
      setVendor((current) =>
        current && next.some((probe) => probe.vendor === current && probe.installed)
          ? current
          : (next.find((probe) => probe.installed)?.vendor ?? null)
      )
    } catch {
      setError("errors.scanFailed")
    } finally {
      setBusy(false)
    }
  }, [])

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void scan()
    else reset()
  }

  const toggleArtifact = (artifact: MigrationArtifact) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(artifact)) next.delete(artifact)
      else next.add(artifact)
      return next
    })
  }

  const onPreview = async () => {
    if (!vendor || selectedArtifacts.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const next = await buildMigrationPreview(vendor, selectedArtifacts, undefined, { cwd })
      setPreview(next)
      setStep("preview")
    } catch {
      setError("errors.previewFailed")
    } finally {
      setBusy(false)
    }
  }

  const onApply = async () => {
    if (!vendor || !preview) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const next = await applyMigration(
        {
          vendor,
          artifacts: selectedArtifacts,
          strategy,
          preview,
          cwd,
          projectId: activeProjectId ?? undefined,
        },
        undefined,
        setProgress,
        controller.signal
      )
      setResult(next)
      setStep("result")
    } catch {
      setError("errors.importFailed")
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const title = step === "result" ? t("result.title") : t("title")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === "result" ? t("result.description") : t("description")}
          </DialogDescription>
        </DialogHeader>

        {step !== "result" && (
          <p className="text-xs text-muted-foreground">
            {t("step", { current: step === "vendor" ? 1 : step === "artifacts" ? 2 : 3, total: 3 })}
          </p>
        )}

        {error && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">{t(error)}</p>
            {step === "vendor" && (
              <Button variant="outline" size="sm" onClick={() => void scan()} disabled={busy}>
                <RefreshCwIcon className="mr-1 size-3.5" />
                {t("retry")}
              </Button>
            )}
          </div>
        )}

        {step === "vendor" && !error && (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("vendor.title")}</p>
            {busy ? (
              <Loading label={t("vendor.scanning")} />
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                {probes.map((probe) => (
                  <Button
                    key={probe.vendor}
                    type="button"
                    variant={vendor === probe.vendor ? "default" : "outline"}
                    className="h-auto min-h-16 flex-col gap-1"
                    disabled={!probe.installed}
                    onClick={() => setVendor(probe.vendor)}
                  >
                    <span>{t(`vendors.${probe.vendor}` as never)}</span>
                    <span className="text-[11px] opacity-70">
                      {t(probe.installed ? "vendor.installed" : "vendor.notInstalled")}
                    </span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "artifacts" && (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("artifacts.title")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {MIGRATION_ARTIFACTS.map((artifact) => (
                <label
                  key={artifact}
                  className="flex cursor-pointer items-center gap-2 rounded-md border p-3"
                >
                  <Checkbox
                    checked={selected.has(artifact)}
                    onCheckedChange={() => toggleArtifact(artifact)}
                    aria-label={t(`artifacts.names.${artifact}` as never)}
                  />
                  <span className="text-sm">{t(`artifacts.names.${artifact}` as never)}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-4">
            <div className="space-y-2">
              {selectedArtifacts.map((artifact) => {
                const cell = preview.artifacts[artifact]
                if (!cell) return null
                return (
                  <div
                    key={artifact}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <span className="text-sm">{t(`artifacts.names.${artifact}` as never)}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{t(`status.${cell.status}` as never)}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {t("preview.items", { count: cell.count })}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            <label className="grid gap-1.5 text-sm" htmlFor="agent-migration-strategy">
              {t("strategy.label")}
              <select
                id="agent-migration-strategy"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as SettingsImportMergeStrategy)}
              >
                <option value="skip">{t("strategy.skip")}</option>
                <option value="overwrite">{t("strategy.overwrite")}</option>
                <option value="duplicate">{t("strategy.duplicate")}</option>
              </select>
            </label>
            {busy && (
              <div className="space-y-2">
                <Loading
                  label={
                    progress
                      ? t("progress.artifact", {
                          artifact: t(`artifacts.names.${progress.artifact}` as never),
                        })
                      : t("progress.starting")
                  }
                />
                <Progress value={progress ? (progress.done / progress.total) * 100 : 0} />
              </div>
            )}
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2Icon className="size-5 text-primary" />
              {result.aborted ? t("result.aborted") : t("result.complete")}
            </div>
            {selectedArtifacts.map((artifact) => {
              const artifactResult = result.artifacts[artifact]
              if (!artifactResult) return null
              return (
                <div
                  key={artifact}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <span className="text-sm">{t(`artifacts.names.${artifact}` as never)}</span>
                  <span className="text-xs text-muted-foreground">
                    {artifactResult.error
                      ? t("errors.artifactFailed")
                      : t("result.imported", { count: artifactResult.imported })}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {step === "vendor" && !error && (
            <Button disabled={!vendor || busy} onClick={() => setStep("artifacts")}>
              {t("continue")}
            </Button>
          )}
          {step === "artifacts" && (
            <>
              <Button variant="outline" onClick={() => setStep("vendor")}>
                <ArrowLeftIcon className="mr-1 size-3.5" />
                {t("back")}
              </Button>
              <Button
                disabled={selectedArtifacts.length === 0 || busy}
                onClick={() => void onPreview()}
              >
                {busy && <Loader2Icon className="mr-1 size-3.5 animate-spin" />}
                {t("preview.action")}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep("artifacts")}>
                <ArrowLeftIcon className="mr-1 size-3.5" />
                {t("back")}
              </Button>
              {busy ? (
                <Button variant="destructive" onClick={() => abortRef.current?.abort()}>
                  {t("cancel")}
                </Button>
              ) : (
                <Button onClick={() => void onApply()}>{t("import")}</Button>
              )}
            </>
          )}
          {step === "result" && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  )
}
