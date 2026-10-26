"use client"

/**
 * Start a Harness Evolution run: the task (request, isolation, inputs,
 * deliverables, checks), how hard to search (mode, k, editable components,
 * budget) and where an improvement may apply. A pre-run estimate from the
 * agent's history is shown before anything is spent, with every ceiling the
 * estimate already exceeds.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import type { Character } from "@cognia/agent-config-types"
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useCapability } from "@/hooks/use-host-profile"
import { K_MAX, effectiveK, normalizeBudget } from "@/lib/harness/budget"
import { harnessEvolutionSettingsOf } from "@/lib/harness/settings"
import type {
  HarnessRunOverrides,
  HarnessRunPreview,
  HarnessTaskDraft,
} from "@/lib/harness/runtime/start"
import { formatMs, formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { useSettingsStore } from "@/stores/settings"
import {
  HARNESS_EVOLUTION_MODES,
  type HarnessEvolutionMode,
  type HarnessIsolationKind,
  type HarnessTaskCheck,
} from "@/types/harness/evolution"
import {
  HARNESS_COMPONENT_NAMES,
  type HarnessComponentName,
  type HarnessScope,
} from "@/types/harness/snapshot"
import { HarnessTaskChecksEditor, availableCheckKinds } from "./harness-task-checks-editor"

const START_CODES = [
  "disabled",
  "trigger-not-allowed",
  "invalid-task",
  "no-commit",
  "model-unavailable",
  "no-session",
  "no-workspace",
] as const
const CAPTURE_CODES = ["agent-not-found", "external-runtime"] as const

export interface HarnessStartRunDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agent: Pick<Character, "id" | "name" | "providerId" | "model">
  /** A task to start from (a failed turn's request). */
  draft?: HarnessTaskDraft
  trigger?: "manual" | "failure-triggered"
  sessionId?: string
  projectId?: string
  onStarted?: (runId: string) => void
}

interface FileRow {
  sourcePath: string
  relativePath: string
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function HarnessStartRunDialog(props: HarnessStartRunDialogProps) {
  // Mounted only while open, so every opening starts from a clean form (and
  // from the draft it was opened with).
  return props.open ? <StartRunForm {...props} /> : null
}

function StartRunForm({
  open,
  onOpenChange,
  agent,
  draft,
  trigger = "manual",
  sessionId,
  projectId,
  onStarted,
}: HarnessStartRunDialogProps) {
  const t = useTranslations("harnessEvolution.start")
  const tRoot = useTranslations("harnessEvolution")
  const appSettings = useSettingsStore((s) => s.settings)
  const canUseFiles = useCapability("shell")
  const settings = useMemo(() => harnessEvolutionSettingsOf(appSettings), [appSettings])

  const [title, setTitle] = useState(draft?.title ?? "")
  const [prompt, setPrompt] = useState(draft?.prompt ?? "")
  const [domain, setDomain] = useState(draft?.domain ?? "")
  const [isolation, setIsolation] = useState<HarnessIsolationKind>(
    draft?.isolation && (draft.isolation === "none" || canUseFiles) ? draft.isolation : "none"
  )
  const [gitRoot, setGitRoot] = useState(draft?.git?.sourceRoot ?? "")
  const [baseRef, setBaseRef] = useState(draft?.git?.baseRef ?? "HEAD")
  const [files, setFiles] = useState<FileRow[]>(draft?.inputFiles ?? [])
  const [deliverables, setDeliverables] = useState((draft?.expectedDeliverables ?? []).join("\n"))
  const [checks, setChecks] = useState<HarnessTaskCheck[]>(draft?.checks ?? [])
  const [mode, setMode] = useState<HarnessEvolutionMode>(settings.defaultMode)
  const [k, setK] = useState(settings.defaultK)
  const [scope, setScope] = useState<HarnessScope>("task")
  const [editable, setEditable] = useState<HarnessComponentName[]>([...HARNESS_COMPONENT_NAMES])
  const [maxCostUsd, setMaxCostUsd] = useState<string>("")
  const [maxWallMinutes, setMaxWallMinutes] = useState<string>("")
  const [networkOff, setNetworkOff] = useState(true)
  const [useExperiences, setUseExperiences] = useState(settings.useExperiences)
  const [preview, setPreview] = useState<HarnessRunPreview | null>(null)
  const [starting, setStarting] = useState(false)

  const taskProjectId = isolation === "git" ? (draft?.git?.projectId ?? projectId) : undefined
  const overrides = useMemo<HarnessRunOverrides>(() => {
    const budget: Partial<NonNullable<HarnessRunOverrides["budget"]>> = {}
    const cost = Number(maxCostUsd)
    if (maxCostUsd.trim() && Number.isFinite(cost)) budget.maxCostUsd = cost
    const minutes = Number(maxWallMinutes)
    if (maxWallMinutes.trim() && Number.isFinite(minutes)) budget.maxWallTimeMs = minutes * 60_000
    return {
      mode,
      k,
      scope,
      editable,
      useExperiences,
      networkOff,
      ...(Object.keys(budget).length ? { budget } : {}),
    }
  }, [mode, k, scope, editable, useExperiences, networkOff, maxCostUsd, maxWallMinutes])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        const start = await import("@/lib/harness/runtime/start")
        const built = start.buildRunConfig(appSettings ?? null, overrides, 0)
        const result = await start.previewHarnessRun(built, agent, {
          estimateSingleRun: start.defaultEstimateSingleRun,
        })
        if (!cancelled) setPreview(result)
      })().catch(() => {
        if (!cancelled) setPreview(null)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [appSettings, overrides, agent])

  const task = (): HarnessTaskDraft => ({
    title,
    prompt,
    ...(domain.trim() ? { domain } : {}),
    isolation,
    ...(isolation === "files" && files.length ? { inputFiles: files } : {}),
    ...(isolation === "git"
      ? {
          git: {
            sourceRoot: gitRoot.trim(),
            baseRef: baseRef.trim() || "HEAD",
            ...(taskProjectId ? { projectId: taskProjectId } : {}),
          },
        }
      : {}),
    ...(isolation !== "none"
      ? {
          expectedDeliverables: deliverables
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        }
      : {}),
    // Checks that no longer fit the task's shape are dropped, not kept dead.
    checks: checks.filter((c) => availableCheckKinds(isolation, taskProjectId).includes(c.kind)),
    source: draft?.source ?? { kind: "custom" },
  })

  const describe = (error: unknown): string => {
    const name = (error as { name?: unknown })?.name
    const code = (error as { code?: unknown })?.code
    if (name === "HarnessStartError" && START_CODES.includes(code as never)) {
      return t(`errors.${code as (typeof START_CODES)[number]}`)
    }
    if (name === "HarnessCaptureError" && CAPTURE_CODES.includes(code as never)) {
      return t(`errors.${code as (typeof CAPTURE_CODES)[number]}`)
    }
    return error instanceof Error ? error.message : String(error)
  }

  const submit = async () => {
    setStarting(true)
    try {
      const [start, control] = await Promise.all([
        import("@/lib/harness/runtime/start"),
        import("@/lib/harness/runtime/run-control"),
      ])
      const draftTask = task()
      const problems = start.validateTaskDraft(draftTask)
      if (problems.length) {
        toast.error(t("invalid"), { description: problems.join(" ") })
        return
      }
      const { created, run } = await start.startHarnessRun(
        {
          characterId: agent.id,
          trigger,
          task: draftTask,
          ...(projectId ? { projectId } : {}),
          ...(sessionId ? { sessionId } : {}),
          overrides,
        },
        await start.defaultStartDeps()
      )
      if (created) {
        void control
          .launchHarnessRun(run.id)
          .catch((error) => toast.error(t("launchFailed"), { description: describe(error) }))
        toast.success(t("started"))
      } else {
        toast.info(t("duplicate"))
      }
      onStarted?.(run.id)
      onOpenChange(false)
    } catch (error) {
      toast.error(t("failed"), { description: describe(error) })
    } finally {
      setStarting(false)
    }
  }

  // The same rule `buildRunConfig` applies: k is capped by the budget.
  const budgetK = effectiveK(
    k,
    normalizeBudget({ ...settings.budget, ...(overrides.budget ?? {}) })
  )
  const scopes: HarnessScope[] = [
    "task",
    ...(sessionId ? (["session"] as const) : []),
    ...(projectId ? (["workspace"] as const) : []),
    "global",
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="harness-start-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("title", { agent: agent.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <Label htmlFor="harness-task-title">{t("taskTitle")}</Label>
            <Input
              id="harness-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Label htmlFor="harness-task-prompt">{t("prompt")}</Label>
            <Textarea
              id="harness-task-prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("promptPlaceholder")}
            />
            <Label htmlFor="harness-task-domain">{t("domain")}</Label>
            <Input
              id="harness-task-domain"
              value={domain}
              placeholder={t("domainPlaceholder")}
              onChange={(e) => setDomain(e.target.value)}
            />
          </section>

          <section className="flex flex-col gap-2">
            <Label htmlFor="harness-isolation">{t("isolation")}</Label>
            <NativeSelect
              id="harness-isolation"
              value={isolation}
              onChange={(e) => setIsolation(e.target.value as HarnessIsolationKind)}
            >
              {(["none", "files", "git"] as const).map((kind) => (
                <NativeSelectOption
                  key={kind}
                  value={kind}
                  disabled={kind !== "none" && !canUseFiles}
                >
                  {tRoot(`isolation.${kind}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t(`isolationHint.${isolation}`)}</p>
            {isolation === "git" ? (
              <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                <div className="flex gap-1.5">
                  <Input
                    value={gitRoot}
                    onChange={(e) => setGitRoot(e.target.value)}
                    placeholder={t("repoPlaceholder")}
                    aria-label={t("repo")}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("pickRepo")}
                    onClick={() =>
                      void import("@/lib/files/file-bridge")
                        .then((m) => m.pickDirectory())
                        .then((dir) => dir && setGitRoot(dir))
                    }
                  >
                    <FolderOpenIcon className="size-4" aria-hidden />
                  </Button>
                </div>
                <Input
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  aria-label={t("baseRef")}
                />
              </div>
            ) : null}
            {isolation === "files" ? (
              <div className="flex flex-col gap-1.5">
                {files.map((file, i) => (
                  <div key={`${file.sourcePath}-${i}`} className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate text-xs" title={file.sourcePath}>
                      {file.sourcePath}
                    </code>
                    <Input
                      className="h-8 w-48"
                      value={file.relativePath}
                      aria-label={t("relativePath")}
                      onChange={(e) =>
                        setFiles(
                          files.map((f, j) =>
                            j === i ? { ...f, relativePath: e.target.value } : f
                          )
                        )
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t("removeFile")}
                      onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() =>
                    void import("@/lib/files/file-bridge")
                      .then((m) => m.pickFilePaths({ multiple: true }))
                      .then((paths) =>
                        setFiles((prev) => [
                          ...prev,
                          ...paths.map((p) => ({ sourcePath: p, relativePath: baseName(p) })),
                        ])
                      )
                  }
                  data-testid="harness-add-files"
                >
                  <PlusIcon className="size-3.5" aria-hidden />
                  {t("addFiles")}
                </Button>
              </div>
            ) : null}
            {isolation !== "none" ? (
              <>
                <Label htmlFor="harness-deliverables">{t("deliverables")}</Label>
                <Textarea
                  id="harness-deliverables"
                  rows={2}
                  value={deliverables}
                  placeholder={t("deliverablesPlaceholder")}
                  onChange={(e) => setDeliverables(e.target.value)}
                />
              </>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">{t("checks")}</h4>
            <HarnessTaskChecksEditor
              checks={checks}
              onChange={setChecks}
              isolation={isolation}
              {...(taskProjectId ? { projectId: taskProjectId } : {})}
            />
          </section>

          <section className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="harness-mode">{t("mode")}</Label>
              <NativeSelect
                id="harness-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as HarnessEvolutionMode)}
              >
                {HARNESS_EVOLUTION_MODES.map((m) => (
                  <NativeSelectOption key={m} value={m}>
                    {tRoot(`mode.${m}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="harness-k">{t("k")}</Label>
              <NativeSelect
                id="harness-k"
                value={String(k)}
                onChange={(e) => setK(Number(e.target.value))}
              >
                {Array.from({ length: K_MAX }, (_, i) => i + 1).map((n) => (
                  <NativeSelectOption key={n} value={String(n)}>
                    {n}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {budgetK < k ? (
                <p className="text-xs text-muted-foreground">{t("kCapped", { k: budgetK })}</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="harness-scope">{t("scope")}</Label>
              <NativeSelect
                id="harness-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as HarnessScope)}
              >
                {scopes.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {tRoot(`decision.scope.${s}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">{t(`scopeHint.${scope}`)}</p>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">{t("editable")}</h4>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {HARNESS_COMPONENT_NAMES.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={editable.includes(c)}
                    onCheckedChange={(v) =>
                      setEditable((prev) =>
                        v === true ? [...prev, c] : prev.filter((x) => x !== c)
                      )
                    }
                  />
                  {tRoot(`component.${c}`)}
                </label>
              ))}
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="harness-max-cost">{t("maxCost")}</Label>
              <Input
                id="harness-max-cost"
                type="number"
                min={0}
                step="0.5"
                value={maxCostUsd}
                placeholder={String(settings.budget.maxCostUsd)}
                onChange={(e) => setMaxCostUsd(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="harness-max-wall">{t("maxWall")}</Label>
              <Input
                id="harness-max-wall"
                type="number"
                min={1}
                value={maxWallMinutes}
                placeholder={String(Math.round(settings.budget.maxWallTimeMs / 60_000))}
                onChange={(e) => setMaxWallMinutes(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={networkOff} onCheckedChange={setNetworkOff} />
              {t("networkOff")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={useExperiences} onCheckedChange={setUseExperiences} />
              {t("useExperiences")}
            </label>
          </section>

          <section
            className="rounded-md border bg-muted/30 p-3 text-sm"
            data-testid="harness-estimate"
          >
            <h4 className="mb-1 font-medium">{t("estimate")}</h4>
            {preview ? (
              <div className="flex flex-col gap-1">
                <p>
                  {t("estimateWork", {
                    rollouts: preview.estimate.work.rollouts,
                    sessions: preview.estimate.work.editorSessions,
                    calls: preview.estimate.modelCalls,
                  })}
                </p>
                <p className="tabular-nums">
                  {t("estimateSpend", {
                    cost:
                      preview.estimate.costUsd === undefined
                        ? "—"
                        : formatUsd(preview.estimate.costUsd),
                    tokens:
                      preview.estimate.tokens === undefined
                        ? "—"
                        : formatTokens(preview.estimate.tokens),
                    time:
                      preview.estimate.wallTimeMs === undefined
                        ? "—"
                        : formatMs(preview.estimate.wallTimeMs),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`confidence.${preview.confidence}`, { count: preview.sampleCount })}
                </p>
                {preview.estimate.exceeds.length ? (
                  <div className="flex flex-wrap gap-1">
                    {preview.estimate.exceeds.map((dim) => (
                      <Badge key={dim} variant="warning">
                        {t("exceeds", { dimension: t(`budgetDimension.${dim}`) })}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("estimating")}</p>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={starting || !title.trim() || !prompt.trim() || editable.length === 0}
            onClick={() => void submit()}
            data-testid="harness-start-submit"
          >
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
