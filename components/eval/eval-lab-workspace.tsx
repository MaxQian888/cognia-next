"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import {
  ActivityIcon,
  ArchiveIcon,
  BarChart3Icon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  FileCheck2Icon,
  GitCompareIcon,
  ListChecksIcon,
  MicroscopeIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  CopyIcon,
  RotateCcwIcon,
  ScaleIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"
import {
  evaluateJudgeCalibration,
  runProjectPreflight,
  type EvalCapability,
  type EvalEnvironmentCompatibility,
  type EvalExperimentState,
  type EvalMode,
  type EvalProject,
  type EvalProjectDataset,
  type EvalVariant,
} from "@cognia/eval-core"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ClampedNumberInput } from "@/components/settings/common/clamped-number-input"
import { Label } from "@/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { APP_VERSION } from "@/lib/app-version"
import { useRunConfigOptions } from "@/hooks/eval/use-run-config-options"
import { collectModelOptions } from "@/lib/ai/model-options"
import { loadOrCreateEvalArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { createBrowserEvalOrchestrator } from "@/lib/ai/eval/browser-execution"
import {
  applyEnvironmentReadiness,
  checkEvalEnvironmentCompatibility,
} from "@/lib/ai/eval/environment-preflight"
import {
  listEvalProviderIds,
  loadEvalDatasetSelection,
  resolveEvalProviderLocality,
  resolveEvalVariantReadiness,
} from "@/lib/ai/eval/project-inputs"
import { EvalProjectService } from "@/lib/ai/eval/project-service"
import { recoverEvalQueueOnStartup } from "@/lib/ai/eval/recovery"
import {
  filterEvalReportCases,
  loadEvalReportView,
  type EvalReportView,
} from "@/lib/ai/eval/report-view"
import { SCORING_VERSION } from "@cognia/eval-core"
import { deterministicScorers } from "@cognia/eval-core"
import { browserEvalConfigurationApplicationDeps } from "@/lib/ai/eval/configuration-targets"
import {
  applyEvalRecommendation,
  previewConfigurationDiff,
  rollbackEvalRecommendation,
  type EvalConfigurationDiffEntry,
  type EvalConfigurationTarget,
} from "@/lib/ai/eval/recommendation-application"
import { ensureEvalStarterDataset } from "@/lib/ai/eval/starter-template"
import { listRecentCalibrationRuns, type CalibrationRunRow } from "@/lib/db/calibration-runs"
import {
  deleteExpiredEvalArtifacts,
  getLatestEvalConfigurationApply,
  listEvalExperiments,
  listEvalProjects,
  saveEvalProject,
  type EvalConfigurationApplyRow,
  type EvalExperimentRow,
} from "@/lib/db/eval-lab"
import { listDatasetSummaries, type EvalDatasetSummary } from "@/lib/ai/eval/service"
import { cn } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings"
import { CalibrationPanel } from "./calibration-panel"
import { BlindReviewPanel } from "./blind-review-panel"
import { EvalDashboard } from "./eval-dashboard"
import { RunsComparePanel } from "./runs-compare-panel"
import { TraceAnnotationPanel } from "./trace-annotation-panel"

const STEPS = ["goal", "data", "variants", "scoring", "preflight", "run", "review"] as const
const DECLARABLE_CAPABILITIES: EvalCapability[] = [
  "image",
  "audio",
  "video",
  "document",
  "tool",
  "structured-output",
  "rag",
  "trajectory",
]
const ATTACHMENT_CAPABILITIES = new Set<EvalCapability>(["image", "audio", "video", "document"])
type EvalLabStep = (typeof STEPS)[number]
type LegacyTool = "datasets" | "compare" | "annotate" | "calibrate" | null
type QueueState = EvalExperimentState

/** The queue states that are still moving and therefore worth polling. */
const POLLING_STATES: readonly QueueState[] = ["queued", "running", "paused", "interrupted"]

/**
 * Bounds for the decision-policy number fields.
 *
 * `runProjectPreflight` rejects a non-finite weight, constraint value,
 * confidence level, case count or retention day count with its own blocking
 * issue code, and a bare `Number(event.target.value)` reaches it as `0` the
 * moment the field is cleared for retyping. `ClampedNumberInput` keeps the
 * typed text in a draft and only commits a finite, in-range value, so a
 * half-typed entry can no longer be persisted into the project.
 *
 * The bounds are deliberately wide: weights are relative rather than
 * normalised, and a constraint threshold can name any metric's scale.
 */
const WEIGHT_MAX = 1_000
const CONSTRAINT_VALUE_BOUND = 1_000_000
const CASE_COUNT_MAX = 1_000_000
const RETENTION_DAYS_MAX = 3_650

const DEFAULT_DECISION_POLICY: EvalProject["decisionPolicy"] = {
  formal: true,
  dimensions: [
    { metric: "quality", direction: "maximize", weight: 0.55 },
    { metric: "reliability", direction: "maximize", weight: 0.2 },
    { metric: "cost", direction: "minimize", weight: 0.15 },
    { metric: "latency", direction: "minimize", weight: 0.1 },
  ],
  constraints: [{ metric: "quality", operator: "gte", value: 0.8 }],
  confidenceLevel: 0.95,
  minimumEffectiveCases: 30,
}

const DEFAULT_PRIVACY_POLICY: EvalProject["privacyPolicy"] = {
  cloudPiiMode: "redact",
  mediaClearance: "local-only",
}

interface ExperimentProgress {
  total: number
  completed: number
  spentCost: number
  reservedCost: number
  budgetCap: number
}

const STEP_ICONS = {
  goal: SparklesIcon,
  data: DatabaseIcon,
  variants: SlidersHorizontalIcon,
  scoring: ListChecksIcon,
  preflight: ShieldCheckIcon,
  run: PlayIcon,
  review: BarChart3Icon,
} satisfies Record<EvalLabStep, typeof SparklesIcon>

function initialVariant(id: string, name: string): EvalVariant {
  return {
    id,
    name,
    kind: "model",
    providerId: "",
    modelId: "",
    runtimeTarget: "web",
    isLocal: false,
    capabilities: ["text"],
    available: false,
    credentialReady: false,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * First spreadsheet-style name not already taken: A…Z, then AA, AB, …
 *
 * Deriving the name from `variants.length` collides the moment a variant is
 * removed (A, B, C minus B is length 2, so the next add is a second "C") and
 * stops producing letters at all past 26, where `65 + 26` is `[`. Variant names
 * are what the report and comparison views label columns with, so a duplicate
 * there is genuinely ambiguous.
 */
function nextVariantName(current: readonly EvalVariant[]): string {
  const taken = new Set(current.map((variant) => variant.name))
  for (let ordinal = 0; ; ordinal += 1) {
    let name = ""
    for (let rest = ordinal; ; rest = Math.floor(rest / 26) - 1) {
      name = String.fromCharCode(65 + (rest % 26)) + name
      if (rest < 26) break
    }
    if (!taken.has(name)) return name
  }
}

function EvidenceContent({
  issueCount,
  retentionDays,
  mediaClearance,
}: {
  issueCount: number
  retentionDays: number
  mediaClearance: EvalProject["privacyPolicy"]["mediaClearance"]
}) {
  const t = useTranslations("eval")
  return (
    <div className="space-y-4 p-4 text-sm">
      <div>
        <p className="font-medium">{t("lab.evidence.manifest")}</p>
        <p className="mt-1 text-muted-foreground">{t("lab.evidence.manifestHint")}</p>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border bg-muted/25 p-3">
          <p className="text-xs text-muted-foreground">{t("lab.evidence.issues")}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{issueCount}</p>
        </div>
        <div className="col-span-2 rounded-lg border bg-muted/25 p-3">
          <p className="text-xs text-muted-foreground">{t("lab.evidence.clearance")}</p>
          <p className="mt-1 font-semibold">
            {t(`lab.evidence.clearanceValues.${mediaClearance}`)}
          </p>
        </div>
        <div className="rounded-lg border bg-muted/25 p-3">
          <p className="text-xs text-muted-foreground">{t("lab.evidence.retention")}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{retentionDays}</p>
        </div>
      </div>
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>{t("lab.evidence.encrypted")}</AlertTitle>
        <AlertDescription>{t("lab.evidence.encryptedHint")}</AlertDescription>
      </Alert>
    </div>
  )
}

export function EvalLabWorkspace() {
  const t = useTranslations("eval")
  const format = useFormatter()
  const router = useRouter()
  const appSettings = useSettingsStore((state) => state.settings)
  const accountId = useAccountStore((state) => state.unlockedAccountId)
  const runOptions = useRunConfigOptions()
  const [step, setStep] = useState<EvalLabStep>("goal")
  const [mode, setMode] = useState<EvalMode>("model")
  const [projectName, setProjectName] = useState("")
  const [description, setDescription] = useState("")
  const [formal, setFormal] = useState(true)
  const [decisionPolicy, setDecisionPolicy] = useState<EvalProject["decisionPolicy"]>(() =>
    structuredClone(DEFAULT_DECISION_POLICY)
  )
  const [privacyPolicy, setPrivacyPolicy] = useState<EvalProject["privacyPolicy"]>(() =>
    structuredClone(DEFAULT_PRIVACY_POLICY)
  )
  const [retentionDays, setRetentionDays] = useState(90)
  const [budget, setBudget] = useState(10)
  const [dataset, setDataset] = useState<EvalProjectDataset | null>(null)
  const [datasets, setDatasets] = useState<EvalDatasetSummary[]>([])
  const [savedProjects, setSavedProjects] = useState<EvalProject[]>([])
  const [projectExperiments, setProjectExperiments] = useState<EvalExperimentRow[]>([])
  const [datasetLoading, setDatasetLoading] = useState(false)
  const [variants, setVariants] = useState<EvalVariant[]>([
    initialVariant("variant-a", "A"),
    initialVariant("variant-b", "B"),
  ])
  const [legacyTool, setLegacyTool] = useState<LegacyTool>(null)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [queueState, setQueueState] = useState<QueueState>("draft")
  const [experimentId, setExperimentId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ExperimentProgress>({
    total: 0,
    completed: 0,
    spentCost: 0,
    reservedCost: 0,
    budgetCap: 0,
  })
  const [runError, setRunError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [controlPending, setControlPending] = useState(false)
  const [judgeProvider, setJudgeProvider] = useState("")
  const [judgeModel, setJudgeModel] = useState("")
  const [judgeInputPrice, setJudgeInputPrice] = useState(0)
  const [judgeOutputPrice, setJudgeOutputPrice] = useState(0)
  const [secondJudgeProvider, setSecondJudgeProvider] = useState("")
  const [secondJudgeModel, setSecondJudgeModel] = useState("")
  const [secondJudgeInputPrice, setSecondJudgeInputPrice] = useState(0)
  const [secondJudgeOutputPrice, setSecondJudgeOutputPrice] = useState(0)
  const [calibrationRuns, setCalibrationRuns] = useState<CalibrationRunRow[]>([])
  const [reportView, setReportView] = useState<EvalReportView | null>(null)
  const [reportVariant, setReportVariant] = useState("")
  const [reportStatus, setReportStatus] = useState("")
  const [applicationTarget, setApplicationTarget] = useState<EvalConfigurationTarget>({
    targetType: "default-model",
    targetId: "global",
  })
  const [applicationDiff, setApplicationDiff] = useState<EvalConfigurationDiffEntry[]>([])
  const [application, setApplication] = useState<EvalConfigurationApplyRow | null>(null)
  const [applicationError, setApplicationError] = useState<string | null>(null)
  const [applicationPending, setApplicationPending] = useState(false)
  const [artifactKey, setArtifactKey] = useState<Uint8Array | null>(null)
  const [environmentCheck, setEnvironmentCheck] = useState<{
    revision: string
    result: EvalEnvironmentCompatibility
  } | null>(null)
  const [projectId, setProjectId] = useState(() => `eval-project-${crypto.randomUUID()}`)
  const [projectCreatedAt, setProjectCreatedAt] = useState(() => Date.now())
  const [projectUpdatedAt, setProjectUpdatedAt] = useState(() => Date.now())
  const orchestratorRef = useRef<ReturnType<typeof createBrowserEvalOrchestrator> | null>(null)
  const stepRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectionGenerationRef = useRef(0)

  const refreshDatasets = useCallback(async () => {
    setDatasets(await listDatasetSummaries())
  }, [])

  useEffect(() => {
    let active = true
    void deleteExpiredEvalArtifacts().catch(() => undefined)
    void Promise.all([listDatasetSummaries(), listRecentCalibrationRuns(), listEvalProjects()])
      .then(([datasetRows, calibrationRows, projectRows]) => {
        if (!active) return
        setDatasets(datasetRows)
        setCalibrationRuns(calibrationRows)
        setSavedProjects(projectRows)
      })
      .catch((error) => {
        if (active) setActionError(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [])

  const providerIds = useMemo(() => listEvalProviderIds(appSettings), [appSettings])
  const modelOptions = useMemo(
    () => collectModelOptions(appSettings?.providerSettings, appSettings?.customProviders),
    [appSettings]
  )
  const judgeIsLocal = useMemo(
    () => resolveEvalProviderLocality(judgeProvider, appSettings),
    [appSettings, judgeProvider]
  )
  const secondJudgeIsLocal = useMemo(
    () => resolveEvalProviderLocality(secondJudgeProvider, appSettings),
    [appSettings, secondJudgeProvider]
  )
  const resolvedVariants = useMemo(
    () => variants.map((variant) => resolveEvalVariantReadiness(variant, appSettings)),
    [appSettings, variants]
  )
  const calibration = useMemo(
    () => calibrationRuns.find((item) => item.judgeModel === judgeModel),
    [calibrationRuns, judgeModel]
  )

  const project = useMemo<EvalProject>(() => {
    const calibrationStatus = evaluateJudgeCalibration({
      anchorCount: calibration?.scoredCount ?? 0,
      kappa: calibration?.metrics.cohenKappa ?? 0,
      accuracy: calibration?.metrics.accuracy ?? 0,
    })
    return {
      id: projectId,
      name: projectName || t("lab.project.untitled"),
      description,
      mode,
      dataset: dataset ?? {
        datasetId: "",
        version: 0,
        digest: "",
        caseIds: [],
        holdoutCaseIds: [],
        requiredModalities: ["text"],
      },
      variants: resolvedVariants,
      decisionPolicy: { ...decisionPolicy, formal },
      budget: { currency: "USD", hardCap: budget, confirmed: budget > 0 },
      judgePolicy: {
        enabled: formal,
        ...(judgeProvider ? { providerId: judgeProvider } : {}),
        ...(judgeModel ? { modelId: judgeModel } : {}),
        isLocal: judgeIsLocal,
        ...(!judgeIsLocal
          ? {
              price: {
                currency: "USD",
                inputPerMillion: judgeInputPrice,
                outputPerMillion: judgeOutputPrice,
              },
            }
          : {}),
        maxOutputTokens: 300,
        ...(secondJudgeProvider ? { secondJudgeProviderId: secondJudgeProvider } : {}),
        ...(secondJudgeModel ? { secondJudgeModelId: secondJudgeModel } : {}),
        secondJudgeIsLocal,
        ...(!secondJudgeIsLocal
          ? {
              secondJudgePrice: {
                currency: "USD",
                inputPerMillion: secondJudgeInputPrice,
                outputPerMillion: secondJudgeOutputPrice,
              },
            }
          : {}),
        calibrated: Boolean(calibration) && calibrationStatus.passed,
        anchorCount: calibration?.scoredCount ?? 0,
        kappa: calibration?.metrics.cohenKappa ?? 0,
        accuracy: calibration?.metrics.accuracy ?? 0,
      },
      privacyPolicy,
      retentionDays,
      createdAt: projectCreatedAt,
      updatedAt: projectUpdatedAt,
    }
  }, [
    budget,
    calibration,
    dataset,
    decisionPolicy,
    description,
    formal,
    judgeModel,
    judgeProvider,
    judgeInputPrice,
    judgeIsLocal,
    judgeOutputPrice,
    secondJudgeInputPrice,
    secondJudgeIsLocal,
    secondJudgeModel,
    secondJudgeOutputPrice,
    secondJudgeProvider,
    mode,
    projectCreatedAt,
    projectId,
    projectName,
    projectUpdatedAt,
    privacyPolicy,
    retentionDays,
    resolvedVariants,
    t,
  ])
  const environmentRevision = useMemo(
    () =>
      JSON.stringify({
        dataset: project.dataset.digest,
        cases: project.dataset.caseIds.length,
        variants: project.variants.map((variant) => ({
          id: variant.id,
          kind: variant.kind,
          targetId: variant.targetId,
          runtimeTarget: variant.runtimeTarget,
          available: variant.available,
        })),
      }),
    [project]
  )
  const environment =
    environmentCheck?.revision === environmentRevision ? environmentCheck.result : undefined
  const preflightProject = environment ? applyEnvironmentReadiness(project, environment) : project
  const preflight = useMemo(
    () => runProjectPreflight(preflightProject, environment),
    [environment, preflightProject]
  )
  const currentIndex = STEPS.indexOf(step)

  useEffect(() => {
    let active = true
    void checkEvalEnvironmentCompatibility(project)
      .then((result) => {
        if (active) setEnvironmentCheck({ revision: environmentRevision, result })
      })
      .catch((error) => {
        if (active) setActionError(errorMessage(error))
      })
    return () => {
      active = false
    }
  }, [environmentRevision, project])

  const changeStep = (next: EvalLabStep) => {
    setLegacyTool(null)
    setStep(next)
  }

  const saveProjectDraft = async () => {
    const generation = selectionGenerationRef.current
    setActionError(null)
    try {
      const updatedAt = Date.now()
      const saved = { ...project, updatedAt }
      await saveEvalProject(saved)
      const projects = await listEvalProjects()
      if (selectionGenerationRef.current !== generation) return
      setProjectUpdatedAt(updatedAt)
      setSavedProjects(projects)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setActionError(errorMessage(error))
    }
  }

  const resetProject = () => {
    const now = Date.now()
    selectionGenerationRef.current += 1
    setProjectId(`eval-project-${crypto.randomUUID()}`)
    setProjectCreatedAt(now)
    setProjectUpdatedAt(now)
    setProjectName("")
    setDescription("")
    setMode("model")
    setFormal(true)
    setDecisionPolicy(structuredClone(DEFAULT_DECISION_POLICY))
    setPrivacyPolicy(structuredClone(DEFAULT_PRIVACY_POLICY))
    setRetentionDays(90)
    setBudget(10)
    setDataset(null)
    setVariants([initialVariant("variant-a", "A"), initialVariant("variant-b", "B")])
    setProjectExperiments([])
    setExperimentId(null)
    setQueueState("draft")
    setProgress({ total: 0, completed: 0, spentCost: 0, reservedCost: 0, budgetCap: 0 })
    setRunError(null)
    setActionError(null)
    setControlPending(false)
    setJudgeProvider("")
    setJudgeModel("")
    setJudgeInputPrice(0)
    setJudgeOutputPrice(0)
    setSecondJudgeProvider("")
    setSecondJudgeModel("")
    setSecondJudgeInputPrice(0)
    setSecondJudgeOutputPrice(0)
    setReportView(null)
    setReportVariant("")
    setReportStatus("")
    setApplicationTarget({ targetType: "default-model", targetId: "global" })
    setApplicationDiff([])
    setApplication(null)
    setApplicationError(null)
    setApplicationPending(false)
    setEnvironmentCheck(null)
    setLegacyTool(null)
    setStep("goal")
  }

  const loadSavedProject = (id: string) => {
    if (!id) {
      resetProject()
      return
    }
    const saved = savedProjects.find((item) => item.id === id)
    if (!saved) return
    const generation = ++selectionGenerationRef.current
    setProjectId(saved.id)
    setProjectCreatedAt(saved.createdAt)
    setProjectUpdatedAt(saved.updatedAt)
    setProjectName(saved.name)
    setDescription(saved.description ?? "")
    setMode(saved.mode)
    setDataset(structuredClone(saved.dataset))
    setVariants(structuredClone(saved.variants))
    setFormal(saved.decisionPolicy.formal)
    setDecisionPolicy(structuredClone(saved.decisionPolicy))
    setPrivacyPolicy(structuredClone(saved.privacyPolicy))
    setRetentionDays(saved.retentionDays)
    setBudget(saved.budget.hardCap)
    setJudgeProvider(saved.judgePolicy.providerId ?? "")
    setJudgeModel(saved.judgePolicy.modelId ?? "")
    setJudgeInputPrice(saved.judgePolicy.price?.inputPerMillion ?? 0)
    setJudgeOutputPrice(saved.judgePolicy.price?.outputPerMillion ?? 0)
    setSecondJudgeProvider(saved.judgePolicy.secondJudgeProviderId ?? "")
    setSecondJudgeModel(saved.judgePolicy.secondJudgeModelId ?? "")
    setSecondJudgeInputPrice(saved.judgePolicy.secondJudgePrice?.inputPerMillion ?? 0)
    setSecondJudgeOutputPrice(saved.judgePolicy.secondJudgePrice?.outputPerMillion ?? 0)
    setExperimentId(null)
    setProjectExperiments([])
    setQueueState("draft")
    setProgress({ total: 0, completed: 0, spentCost: 0, reservedCost: 0, budgetCap: 0 })
    setRunError(null)
    setActionError(null)
    setControlPending(false)
    setReportView(null)
    setReportVariant("")
    setReportStatus("")
    setApplicationTarget({ targetType: "default-model", targetId: "global" })
    setApplicationDiff([])
    setApplication(null)
    setApplicationError(null)
    setApplicationPending(false)
    setEnvironmentCheck(null)
    setStep("goal")
    void listEvalExperiments(saved.id)
      .then((rows) => {
        if (selectionGenerationRef.current === generation) setProjectExperiments(rows)
      })
      .catch((error) => {
        if (selectionGenerationRef.current === generation) setActionError(errorMessage(error))
      })
  }

  const onStepKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0
    if (!direction) return
    event.preventDefault()
    const nextIndex = Math.min(STEPS.length - 1, Math.max(0, index + direction))
    changeStep(STEPS[nextIndex])
    stepRefs.current[nextIndex]?.focus()
  }

  const updateVariant = (index: number, patch: Partial<EvalVariant>) => {
    setVariants((current) =>
      current.map((variant, variantIndex) => {
        if (variantIndex !== index) return variant
        return resolveEvalVariantReadiness({ ...variant, ...patch }, appSettings)
      })
    )
  }

  const addVariant = () => {
    setVariants((current) => [
      ...current,
      initialVariant(`variant-${crypto.randomUUID()}`, nextVariantName(current)),
    ])
  }

  const duplicateVariant = (index: number) => {
    setVariants((current) => {
      const source = current[index]
      if (!source) return current
      return [
        ...current,
        {
          ...structuredClone(source),
          id: `variant-${crypto.randomUUID()}`,
          name: t("lab.variants.copyName", { name: source.name }),
        },
      ]
    })
  }

  const removeVariant = (index: number) => {
    setVariants((current) =>
      current.length <= 2 ? current : current.filter((_, variantIndex) => variantIndex !== index)
    )
  }

  const changeMode = (nextMode: EvalMode) => {
    setMode(nextMode)
    setVariants((current) =>
      current.map((variant) => {
        const parameters = { ...variant.parameters }
        delete parameters.workflowVersionId
        return resolveEvalVariantReadiness(
          nextMode === "model"
            ? {
                ...variant,
                kind: "model",
                targetId: undefined,
                runtimeTarget: "web",
                parameters,
              }
            : {
                ...variant,
                kind: "chat",
                targetId: undefined,
                runtimeTarget: "desktop",
                parameters: undefined,
              },
          appSettings
        )
      })
    )
  }

  const selectDataset = async (datasetId: string) => {
    if (!datasetId) {
      setDataset(null)
      setPrivacyPolicy(structuredClone(DEFAULT_PRIVACY_POLICY))
      return
    }
    setDatasetLoading(true)
    setRunError(null)
    try {
      const selection = await loadEvalDatasetSelection(datasetId)
      setDataset(selection)
      setPrivacyPolicy({
        cloudPiiMode: "redact",
        mediaClearance: selection.mediaClearance ?? "local-only",
      })
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setDatasetLoading(false)
    }
  }

  const selectStarterDataset = async () => {
    setDatasetLoading(true)
    setRunError(null)
    try {
      const starter = await ensureEvalStarterDataset({
        name: t("lab.data.starterDatasetName"),
        description: t("lab.data.starterDatasetDescription"),
      })
      await refreshDatasets()
      const selection = await loadEvalDatasetSelection(starter.id)
      setDataset(selection)
      setPrivacyPolicy({
        cloudPiiMode: "redact",
        mediaClearance: selection.mediaClearance ?? "local-only",
      })
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setDatasetLoading(false)
    }
  }

  const refreshExperimentStatus = useCallback(async (id: string, generation?: number) => {
    const status = await new EvalProjectService().status(id)
    if (generation !== undefined && selectionGenerationRef.current !== generation) return
    const completed = status.tasks.completed ?? 0
    const total = Object.values(status.tasks).reduce((sum, count) => sum + (count ?? 0), 0)
    setQueueState(status.experiment.state)
    setProgress({
      total,
      completed,
      spentCost: status.experiment.spentCost,
      reservedCost: status.experiment.reservedCost,
      budgetCap: status.experiment.budgetCap ?? status.experiment.manifest.budget.hardCap,
    })
    return status.experiment.state
  }, [])

  const refreshReport = useCallback(
    async (id: string, generation?: number) => {
      if (!accountId) return
      const key = artifactKey ?? (await loadOrCreateEvalArtifactKey(accountId))
      if (generation !== undefined && selectionGenerationRef.current !== generation) return
      setArtifactKey(key)
      const view = await loadEvalReportView(id, key)
      if (generation !== undefined && selectionGenerationRef.current !== generation) return
      setReportView(view)
    },
    [accountId, artifactKey]
  )

  const restoreExperiment = async (id: string) => {
    if (!id) {
      selectionGenerationRef.current += 1
      setExperimentId(null)
      setQueueState("draft")
      setReportView(null)
      setApplicationDiff([])
      setApplication(null)
      return
    }
    const generation = ++selectionGenerationRef.current
    setActionError(null)
    setExperimentId(id)
    setApplicationDiff([])
    try {
      const latestApplication = await getLatestEvalConfigurationApply(id)
      if (selectionGenerationRef.current !== generation) return
      setApplication(latestApplication ?? null)
      await refreshExperimentStatus(id, generation)
      await refreshReport(id, generation)
      if (selectionGenerationRef.current === generation) setStep("review")
    } catch (error) {
      if (selectionGenerationRef.current === generation) setActionError(errorMessage(error))
    }
  }

  useEffect(() => {
    let active = true
    const generation = selectionGenerationRef.current
    void recoverEvalQueueOnStartup()
      .then(async (rows) => {
        const latest = rows[0]
        if (!active || !latest || selectionGenerationRef.current !== generation) return
        setExperimentId(latest.experimentId)
        setQueueState(latest.state)
        await refreshExperimentStatus(latest.experimentId, generation)
      })
      .catch((error) => {
        if (active && selectionGenerationRef.current === generation) {
          setActionError(errorMessage(error))
        }
      })
    return () => {
      active = false
    }
  }, [refreshExperimentStatus])

  // Read through a ref, not a dependency: `refreshReport` closes over
  // `artifactKey`, so listing it below tore the 2s interval down and rebuilt it
  // mid-poll the first time a report load set that key.
  const refreshReportRef = useRef(refreshReport)
  useEffect(() => {
    refreshReportRef.current = refreshReport
  }, [refreshReport])

  useEffect(() => {
    if (!experimentId || !POLLING_STATES.includes(queueState)) return
    const generation = selectionGenerationRef.current
    const timer = window.setInterval(() => {
      void refreshExperimentStatus(experimentId, generation)
        .then((state) => {
          if (state === "completed" || state === "failed" || state === "cancelled") {
            return refreshReportRef.current(experimentId, generation)
          }
        })
        .catch((error) => {
          if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
        })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [experimentId, queueState, refreshExperimentStatus])

  const runPersistedExperiment = useCallback(
    (
      id: string,
      orchestrator: ReturnType<typeof createBrowserEvalOrchestrator>,
      generation = selectionGenerationRef.current
    ) => {
      void orchestrator
        .run(id)
        .then(async () => {
          await refreshExperimentStatus(id, generation)
          await refreshReport(id, generation)
        })
        .catch((error) => {
          if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
          void refreshExperimentStatus(id, generation)
        })
    },
    [refreshExperimentStatus, refreshReport]
  )

  const startExperiment = async () => {
    if (!appSettings || !accountId || controlPending) return
    const generation = selectionGenerationRef.current
    setControlPending(true)
    setRunError(null)
    try {
      const checkedEnvironment = await checkEvalEnvironmentCompatibility(project)
      const checkedProject = applyEnvironmentReadiness(project, checkedEnvironment)
      const checkedPreflight = runProjectPreflight(checkedProject, checkedEnvironment)
      if (selectionGenerationRef.current === generation) {
        setEnvironmentCheck({ revision: environmentRevision, result: checkedEnvironment })
      }
      if (!checkedPreflight.ok) return
      const artifactKey = await loadOrCreateEvalArtifactKey(accountId)
      if (selectionGenerationRef.current === generation) setArtifactKey(artifactKey)
      const updatedAt = Date.now()
      await saveEvalProject({ ...checkedProject, updatedAt })
      if (selectionGenerationRef.current === generation) setProjectUpdatedAt(updatedAt)
      const scorerVersions = Object.fromEntries(
        deterministicScorers().map((scorer) => [scorer.id, String(SCORING_VERSION)])
      )
      const randomSeed = crypto.getRandomValues(new Uint32Array(1))[0]
      const experiment = await new EvalProjectService().start(project.id, {
        appVersion: APP_VERSION,
        scorerVersions,
        randomSeed,
        environmentCompatibility: checkedEnvironment,
      })
      const orchestrator = createBrowserEvalOrchestrator({ appSettings, artifactKey })
      orchestratorRef.current = orchestrator
      if (selectionGenerationRef.current === generation) {
        setExperimentId(experiment.id)
        setQueueState("queued")
      }
      await refreshExperimentStatus(experiment.id, generation)
      runPersistedExperiment(experiment.id, orchestrator, generation)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
    } finally {
      setControlPending(false)
    }
  }

  const pauseExperiment = async () => {
    if (!experimentId || controlPending) return
    const generation = selectionGenerationRef.current
    setControlPending(true)
    setRunError(null)
    try {
      await new EvalProjectService().pause(experimentId)
      await refreshExperimentStatus(experimentId, generation)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
    } finally {
      setControlPending(false)
    }
  }

  const resumeExperiment = async () => {
    if (!experimentId || !appSettings || !accountId || controlPending) return
    const generation = selectionGenerationRef.current
    setControlPending(true)
    setRunError(null)
    try {
      await new EvalProjectService().resume(experimentId)
      const orchestrator =
        orchestratorRef.current ??
        createBrowserEvalOrchestrator({
          appSettings,
          artifactKey: await loadOrCreateEvalArtifactKey(accountId),
        })
      orchestratorRef.current = orchestrator
      runPersistedExperiment(experimentId, orchestrator, generation)
      await refreshExperimentStatus(experimentId, generation)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
    } finally {
      setControlPending(false)
    }
  }

  const cancelExperiment = async () => {
    if (!experimentId || controlPending) return
    const generation = selectionGenerationRef.current
    setControlPending(true)
    setRunError(null)
    try {
      await new EvalProjectService().cancel(experimentId)
      await refreshExperimentStatus(experimentId, generation)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
    } finally {
      setControlPending(false)
    }
  }

  const extendBudget = async () => {
    if (!experimentId || controlPending) return
    const generation = selectionGenerationRef.current
    setControlPending(true)
    setRunError(null)
    try {
      await new EvalProjectService().extendBudget(experimentId, budget)
      await refreshExperimentStatus(experimentId, generation)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setRunError(errorMessage(error))
    } finally {
      setControlPending(false)
    }
  }

  const filteredReportCases = useMemo(
    () =>
      reportView
        ? filterEvalReportCases(reportView.cases, {
            ...(reportVariant ? { variantId: reportVariant } : {}),
            ...(reportStatus ? { status: reportStatus as "passed" | "failed" | "errored" } : {}),
          })
        : [],
    [reportStatus, reportVariant, reportView]
  )

  const recommendedConfiguration = useMemo<Record<string, unknown> | null>(() => {
    const currentReport = reportView
    if (!currentReport) return null
    const recommendation = currentReport.recommendation?.result
    if (recommendation?.status !== "recommended") return null
    const variant = currentReport.experiment.manifest.variants.find(
      (item) => item.id === recommendation.recommendedVariantId
    )
    if (!variant) return null
    if (applicationTarget.targetType === "default-model") {
      if (!variant.providerId || !variant.modelId) return null
      return { providerId: variant.providerId, modelId: variant.modelId }
    }
    if (applicationTarget.targetType === "character") {
      if (!variant.modelId) return null
      return {
        model: variant.modelId,
        ...(typeof variant.parameters?.systemPrompt === "string"
          ? { systemPrompt: variant.parameters.systemPrompt }
          : {}),
      }
    }
    const configuration = variant.parameters?.applicationConfiguration
    return configuration && typeof configuration === "object" && !Array.isArray(configuration)
      ? (configuration as Record<string, unknown>)
      : null
  }, [applicationTarget.targetType, reportView])

  const previewApplication = async () => {
    if (!recommendedConfiguration || applicationPending) return
    const generation = selectionGenerationRef.current
    const target = { ...applicationTarget }
    setApplicationPending(true)
    setApplicationError(null)
    try {
      const dependencies = await browserEvalConfigurationApplicationDeps()
      const diff = previewConfigurationDiff(
        await dependencies.read(target),
        recommendedConfiguration
      )
      if (selectionGenerationRef.current === generation) setApplicationDiff(diff)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setApplicationError(errorMessage(error))
    } finally {
      setApplicationPending(false)
    }
  }

  const applyRecommendation = async () => {
    if (
      !experimentId ||
      !recommendedConfiguration ||
      !applicationDiff.length ||
      applicationPending
    ) {
      return
    }
    const generation = selectionGenerationRef.current
    const target = { ...applicationTarget }
    setApplicationPending(true)
    setApplicationError(null)
    try {
      const applied = await applyEvalRecommendation(
        experimentId,
        target,
        recommendedConfiguration,
        await browserEvalConfigurationApplicationDeps()
      )
      if (selectionGenerationRef.current === generation) setApplication(applied)
    } catch (error) {
      if (selectionGenerationRef.current === generation) setApplicationError(errorMessage(error))
    } finally {
      setApplicationPending(false)
    }
  }

  const rollbackApplication = async () => {
    if (!application || applicationPending) return
    const generation = selectionGenerationRef.current
    setApplicationPending(true)
    setApplicationError(null)
    try {
      await rollbackEvalRecommendation(
        application.id,
        await browserEvalConfigurationApplicationDeps()
      )
      if (selectionGenerationRef.current === generation) {
        setApplication({ ...application, rolledBackAt: Date.now() })
      }
    } catch (error) {
      if (selectionGenerationRef.current === generation) setApplicationError(errorMessage(error))
    } finally {
      setApplicationPending(false)
    }
  }

  const renderLegacy = () => {
    if (!legacyTool) return null
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => setLegacyTool(null)}>
            <ChevronLeftIcon className="size-4" />
            {t("lab.legacy.back")}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {legacyTool === "datasets" ? <EvalDashboard /> : null}
          {legacyTool === "compare" ? <RunsComparePanel /> : null}
          {legacyTool === "annotate" ? <TraceAnnotationPanel /> : null}
          {legacyTool === "calibrate" ? <CalibrationPanel /> : null}
        </div>
      </div>
    )
  }

  const renderStep = () => {
    if (step === "goal") {
      return (
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.goal.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.goal.description")}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["model", "agent"] as const).map((value) => (
              <Button
                key={value}
                variant={mode === value ? "default" : "outline"}
                className="h-auto min-h-24 justify-start p-4 text-left"
                aria-pressed={mode === value}
                aria-label={t(`lab.mode.${value}`)}
                onClick={() => changeMode(value)}
              >
                {value === "model" ? (
                  <ScaleIcon className="size-5" />
                ) : (
                  <BotIcon className="size-5" />
                )}
                <span>
                  <span className="block font-medium">{t(`lab.mode.${value}`)}</span>
                  <span className="mt-1 block whitespace-normal text-xs opacity-80">
                    {t(`lab.mode.${value}Hint`)}
                  </span>
                </span>
              </Button>
            ))}
          </div>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="eval-project-name">{t("lab.project.name")}</Label>
              <Input
                id="eval-project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder={t("lab.project.namePlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="eval-project-description">{t("lab.project.description")}</Label>
              <Input
                id="eval-project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("lab.project.descriptionPlaceholder")}
              />
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("lab.project.saved")}</CardTitle>
              <CardDescription>{t("lab.project.savedHint")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="grid min-w-0 flex-1 gap-2">
                <Label htmlFor="eval-saved-project">{t("lab.project.saved")}</Label>
                <NativeSelect
                  id="eval-saved-project"
                  wrapperClassName="w-full"
                  value={savedProjects.some((item) => item.id === projectId) ? projectId : ""}
                  onChange={(event) => loadSavedProject(event.target.value)}
                >
                  <NativeSelectOption value="">{t("lab.project.newProject")}</NativeSelectOption>
                  {savedProjects.map((saved) => (
                    <NativeSelectOption key={saved.id} value={saved.id}>
                      {saved.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {projectExperiments.length ? (
                <div className="grid min-w-0 flex-1 gap-2">
                  <Label htmlFor="eval-saved-experiment">{t("lab.project.experiments")}</Label>
                  <NativeSelect
                    id="eval-saved-experiment"
                    wrapperClassName="w-full"
                    value={experimentId ?? ""}
                    onChange={(event) => void restoreExperiment(event.target.value)}
                  >
                    <NativeSelectOption value="">
                      {t("lab.project.selectExperiment")}
                    </NativeSelectOption>
                    {projectExperiments.map((experiment) => (
                      <NativeSelectOption key={experiment.id} value={experiment.id}>
                        {t("lab.project.experimentOption", {
                          state: experiment.state,
                          createdAt: format.dateTime(experiment.createdAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              <Button variant="outline" onClick={() => void saveProjectDraft()}>
                {t("lab.project.saveDraft")}
              </Button>
            </CardContent>
          </Card>
        </div>
      )
    }
    if (step === "data") {
      return (
        <div className="mx-auto w-full max-w-4xl space-y-5">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.data.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.data.description")}</p>
          </div>
          {runError ? (
            <Alert variant="destructive">
              <ShieldCheckIcon />
              <AlertTitle>{t("lab.data.error")}</AlertTitle>
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Card
              className={cn(
                dataset?.datasetId === "eval-lab-starter-v1" && "border-primary/50 bg-primary/5"
              )}
            >
              <CardHeader>
                <CardTitle>{t("lab.data.starter")}</CardTitle>
                <CardDescription>{t("lab.data.starterHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button disabled={datasetLoading} onClick={() => void selectStarterDataset()}>
                  <SparklesIcon />
                  {dataset?.datasetId === "eval-lab-starter-v1"
                    ? t("lab.data.selected")
                    : t("lab.data.useStarter")}
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("lab.data.library")}</CardTitle>
                <CardDescription>{t("lab.data.libraryHint")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2">
                  <Label htmlFor="eval-dataset-select">{t("lab.data.selectDataset")}</Label>
                  <NativeSelect
                    id="eval-dataset-select"
                    wrapperClassName="w-full"
                    value={dataset?.datasetId ?? ""}
                    disabled={datasetLoading}
                    onChange={(event) => void selectDataset(event.target.value)}
                  >
                    <NativeSelectOption value="">
                      {t("lab.data.selectPlaceholder")}
                    </NativeSelectOption>
                    {datasets.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {item.name} · {t("lab.data.caseCount", { count: item.caseCount })}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <Button variant="outline" onClick={() => setLegacyTool("datasets")}>
                  <DatabaseIcon />
                  {t("lab.data.openLibrary")}
                </Button>
              </CardContent>
            </Card>
          </div>
          {dataset ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="py-4">
                <CardContent>
                  <p className="text-xs text-muted-foreground">{t("lab.data.version")}</p>
                  <p className="mt-1 text-lg font-semibold">
                    {t("lab.data.versionValue", { version: dataset.version })}
                  </p>
                </CardContent>
              </Card>
              <Card className="py-4">
                <CardContent>
                  <p className="text-xs text-muted-foreground">{t("lab.data.cases")}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {dataset.caseIds.length}
                  </p>
                </CardContent>
              </Card>
              <Card className="py-4">
                <CardContent>
                  <p className="text-xs text-muted-foreground">{t("lab.data.holdout")}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {dataset.holdoutCaseIds.length}
                  </p>
                </CardContent>
              </Card>
            </div>
          ) : null}
          <Alert>
            <ArchiveIcon />
            <AlertTitle>{t("lab.data.versioned")}</AlertTitle>
            <AlertDescription>{t("lab.data.versionedHint")}</AlertDescription>
          </Alert>
        </div>
      )
    }
    if (step === "variants") {
      return (
        <div className="mx-auto w-full max-w-5xl space-y-5">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.variants.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.variants.description")}</p>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={addVariant}>
              <PlusIcon />
              {t("lab.variants.add")}
            </Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {resolvedVariants.map((variant, index) => (
              <Card key={variant.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{t("lab.variants.variant", { label: variant.name })}</CardTitle>
                    <div className="flex items-center gap-1">
                      <Badge variant={variant.available ? "default" : "secondary"}>
                        {variant.available ? t("lab.variants.ready") : t("lab.variants.incomplete")}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("lab.variants.duplicate")}
                        onClick={() => duplicateVariant(index)}
                      >
                        <CopyIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={resolvedVariants.length <= 2}
                        aria-label={t("lab.variants.remove")}
                        onClick={() => removeVariant(index)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor={`${variant.id}-name`}>{t("lab.variants.name")}</Label>
                    <Input
                      id={`${variant.id}-name`}
                      value={variant.name}
                      onChange={(event) => updateVariant(index, { name: event.target.value })}
                    />
                  </div>
                  {mode === "agent" ? (
                    <div className="grid gap-2">
                      <Label htmlFor={`${variant.id}-kind`}>{t("lab.variants.agentTarget")}</Label>
                      <NativeSelect
                        id={`${variant.id}-kind`}
                        wrapperClassName="w-full"
                        value={variant.kind}
                        onChange={(event) => {
                          const parameters = { ...variant.parameters }
                          delete parameters.workflowVersionId
                          updateVariant(index, {
                            kind: event.target.value as EvalVariant["kind"],
                            targetId: undefined,
                            parameters,
                            capabilities:
                              event.target.value === "team" || event.target.value === "workflow"
                                ? variant.capabilities.filter(
                                    (capability) => !ATTACHMENT_CAPABILITIES.has(capability)
                                  )
                                : variant.capabilities,
                          })
                        }}
                      >
                        <NativeSelectOption value="chat">
                          {t("lab.variants.targetKinds.chat")}
                        </NativeSelectOption>
                        <NativeSelectOption value="team">
                          {t("lab.variants.targetKinds.team")}
                        </NativeSelectOption>
                        <NativeSelectOption value="workflow">
                          {t("lab.variants.targetKinds.workflow")}
                        </NativeSelectOption>
                      </NativeSelect>
                    </div>
                  ) : null}
                  {mode === "model" || variant.kind === "chat" ? (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-provider`}>
                          {t("lab.variants.provider")}
                        </Label>
                        <Input
                          id={`${variant.id}-provider`}
                          list="eval-provider-ids"
                          value={variant.providerId}
                          onChange={(event) => {
                            const providerId = event.target.value
                            updateVariant(index, {
                              providerId,
                              ...(providerId === variant.providerId ? {} : { modelId: "" }),
                            })
                          }}
                          placeholder={t("lab.variants.providerPlaceholder")}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-model`}>{t("lab.variants.model")}</Label>
                        <Input
                          id={`${variant.id}-model`}
                          list={`${variant.id}-model-ids`}
                          value={variant.modelId}
                          onChange={(event) =>
                            updateVariant(index, { modelId: event.target.value })
                          }
                          placeholder={t("lab.variants.modelPlaceholder")}
                        />
                        <datalist id={`${variant.id}-model-ids`}>
                          {modelOptions
                            .filter(
                              (option) =>
                                !variant.providerId || option.providerId === variant.providerId
                            )
                            .map((option) => (
                              <option
                                key={`${option.providerId}:${option.modelId}`}
                                value={option.modelId}
                                label={option.modelName}
                              />
                            ))}
                        </datalist>
                      </div>
                    </>
                  ) : null}
                  {mode === "agent" ? (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-target`}>
                          {t(`lab.variants.targetIds.${variant.kind}`)}
                        </Label>
                        <Input
                          id={`${variant.id}-target`}
                          list={`${variant.id}-${variant.kind}-targets`}
                          value={variant.targetId ?? ""}
                          onChange={(event) =>
                            updateVariant(index, { targetId: event.target.value })
                          }
                          placeholder={t("lab.variants.targetPlaceholder")}
                        />
                        <datalist id={`${variant.id}-${variant.kind}-targets`}>
                          {(
                            (variant.kind === "chat"
                              ? runOptions.characters
                              : variant.kind === "team"
                                ? runOptions.teams
                                : variant.kind === "workflow"
                                  ? runOptions.workflows
                                  : []) ?? []
                          ).map((option) => (
                            <option key={option.id} value={option.id} label={option.name} />
                          ))}
                        </datalist>
                      </div>
                      {variant.kind === "workflow" ? (
                        <div className="grid gap-2">
                          <Label htmlFor={`${variant.id}-workflow-version`}>
                            {t("lab.variants.workflowVersion")}
                          </Label>
                          <Input
                            id={`${variant.id}-workflow-version`}
                            value={
                              (variant.parameters?.workflowVersionId as string | undefined) ?? ""
                            }
                            onChange={(event) =>
                              updateVariant(index, {
                                parameters: {
                                  ...variant.parameters,
                                  workflowVersionId: event.target.value || undefined,
                                },
                              })
                            }
                            placeholder={t("lab.variants.workflowVersionPlaceholder")}
                          />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">{t("lab.variants.local")}</p>
                      <p className="text-xs text-muted-foreground">{t("lab.variants.localHint")}</p>
                    </div>
                    <Badge variant={variant.isLocal ? "default" : "secondary"}>
                      {variant.isLocal
                        ? t("lab.variants.localConfirmed")
                        : t("lab.variants.cloudOrUnverified")}
                    </Badge>
                  </div>
                  {!variant.isLocal ? (
                    <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-input-price`}>
                          {t("lab.variants.inputPrice")}
                        </Label>
                        <Input
                          id={`${variant.id}-input-price`}
                          type="number"
                          min={0}
                          step="0.01"
                          value={variant.price?.inputPerMillion ?? ""}
                          onChange={(event) =>
                            updateVariant(index, {
                              price: {
                                inputPerMillion: Number(event.target.value),
                                outputPerMillion: variant.price?.outputPerMillion ?? 0,
                                currency: "USD",
                              },
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-output-price`}>
                          {t("lab.variants.outputPrice")}
                        </Label>
                        <Input
                          id={`${variant.id}-output-price`}
                          type="number"
                          min={0}
                          step="0.01"
                          value={variant.price?.outputPerMillion ?? ""}
                          onChange={(event) =>
                            updateVariant(index, {
                              price: {
                                inputPerMillion: variant.price?.inputPerMillion ?? 0,
                                outputPerMillion: Number(event.target.value),
                                currency: "USD",
                              },
                            })
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                  {mode === "model" ? (
                    <div className="grid gap-3 rounded-lg border p-3">
                      <div>
                        <p className="text-sm font-medium">{t("lab.variants.inference")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("lab.variants.inferenceHint")}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="grid gap-2">
                          <Label htmlFor={`${variant.id}-temperature`}>
                            {t("lab.variants.temperature")}
                          </Label>
                          <Input
                            id={`${variant.id}-temperature`}
                            type="number"
                            min={0}
                            max={2}
                            step="0.1"
                            value={(variant.parameters?.temperature as number | undefined) ?? ""}
                            onChange={(event) =>
                              updateVariant(index, {
                                parameters: {
                                  ...variant.parameters,
                                  temperature:
                                    event.target.value === ""
                                      ? undefined
                                      : Number(event.target.value),
                                },
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor={`${variant.id}-top-p`}>{t("lab.variants.topP")}</Label>
                          <Input
                            id={`${variant.id}-top-p`}
                            type="number"
                            min={0}
                            max={1}
                            step="0.05"
                            value={(variant.parameters?.topP as number | undefined) ?? ""}
                            onChange={(event) =>
                              updateVariant(index, {
                                parameters: {
                                  ...variant.parameters,
                                  topP:
                                    event.target.value === ""
                                      ? undefined
                                      : Number(event.target.value),
                                },
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor={`${variant.id}-max-output`}>
                            {t("lab.variants.maxOutputTokens")}
                          </Label>
                          <Input
                            id={`${variant.id}-max-output`}
                            type="number"
                            min={1}
                            step={1}
                            value={
                              (variant.parameters?.maxOutputTokens as number | undefined) ?? ""
                            }
                            onChange={(event) =>
                              updateVariant(index, {
                                parameters: {
                                  ...variant.parameters,
                                  maxOutputTokens:
                                    event.target.value === ""
                                      ? undefined
                                      : Number(event.target.value),
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor={`${variant.id}-system-prompt`}>
                          {t("lab.variants.systemPrompt")}
                        </Label>
                        <Textarea
                          id={`${variant.id}-system-prompt`}
                          value={(variant.parameters?.systemPrompt as string | undefined) ?? ""}
                          onChange={(event) =>
                            updateVariant(index, {
                              parameters: {
                                ...variant.parameters,
                                systemPrompt: event.target.value || undefined,
                              },
                            })
                          }
                          placeholder={t("lab.variants.systemPromptPlaceholder")}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-3 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">{t("lab.variants.capabilities")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("lab.variants.capabilitiesHint")}
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {DECLARABLE_CAPABILITIES.map((capability) => {
                        const checked = variant.capabilities.includes(capability)
                        const unsupportedAttachment =
                          (variant.kind === "team" || variant.kind === "workflow") &&
                          ATTACHMENT_CAPABILITIES.has(capability)
                        return (
                          <div
                            key={capability}
                            className="flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2"
                          >
                            <Label htmlFor={`${variant.id}-capability-${capability}`}>
                              {t(`lab.variants.capability.${capability}`)}
                            </Label>
                            <Switch
                              id={`${variant.id}-capability-${capability}`}
                              checked={checked}
                              disabled={unsupportedAttachment}
                              onCheckedChange={(enabled) =>
                                updateVariant(index, {
                                  capabilities: enabled
                                    ? [...new Set([...variant.capabilities, capability])]
                                    : variant.capabilities.filter((item) => item !== capability),
                                })
                              }
                              aria-label={t(`lab.variants.capability.${capability}`)}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <datalist id="eval-provider-ids">
            {providerIds.map((providerId) => (
              <option key={providerId} value={providerId} />
            ))}
          </datalist>
        </div>
      )
    }
    if (step === "scoring") {
      return (
        <div className="mx-auto w-full max-w-4xl space-y-5">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.scoring.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.scoring.description")}</p>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("lab.scoring.policy")}</CardTitle>
              <CardDescription>{t("lab.scoring.policyHint")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">{t("lab.scoring.formal")}</p>
                  <p className="text-xs text-muted-foreground">{t("lab.scoring.formalHint")}</p>
                </div>
                <Switch
                  checked={formal}
                  onCheckedChange={setFormal}
                  aria-label={t("lab.scoring.formal")}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="eval-budget">{t("lab.scoring.budget")}</Label>
                <Input
                  id="eval-budget"
                  type="number"
                  min={0}
                  value={budget}
                  onChange={(event) => setBudget(Number(event.target.value))}
                />
              </div>
              {formal ? (
                <div className="grid gap-4 rounded-lg border p-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="eval-judge-provider">{t("lab.scoring.judgeProvider")}</Label>
                      <Input
                        id="eval-judge-provider"
                        list="eval-provider-ids"
                        value={judgeProvider}
                        onChange={(event) => {
                          const providerId = event.target.value
                          if (providerId !== judgeProvider) setJudgeModel("")
                          setJudgeProvider(providerId)
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="eval-judge-model">{t("lab.scoring.judgeModel")}</Label>
                      <Input
                        id="eval-judge-model"
                        list="eval-judge-models"
                        value={judgeModel}
                        onChange={(event) => setJudgeModel(event.target.value)}
                      />
                      <datalist id="eval-judge-models">
                        {modelOptions
                          .filter((option) => !judgeProvider || option.providerId === judgeProvider)
                          .map((option) => (
                            <option
                              key={`${option.providerId}:${option.modelId}`}
                              value={option.modelId}
                              label={option.modelName}
                            />
                          ))}
                      </datalist>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <span className="text-sm font-medium">{t("lab.scoring.judgeLocal")}</span>
                    <Badge variant={judgeIsLocal ? "default" : "secondary"}>
                      {judgeIsLocal
                        ? t("lab.variants.localConfirmed")
                        : t("lab.variants.cloudOrUnverified")}
                    </Badge>
                  </div>
                  {!judgeIsLocal ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <Label htmlFor="eval-judge-input-price">
                          {t("lab.scoring.judgeInputPrice")}
                        </Label>
                        <Input
                          id="eval-judge-input-price"
                          type="number"
                          min={0}
                          step="0.01"
                          value={judgeInputPrice}
                          onChange={(event) => setJudgeInputPrice(Number(event.target.value))}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="eval-judge-output-price">
                          {t("lab.scoring.judgeOutputPrice")}
                        </Label>
                        <Input
                          id="eval-judge-output-price"
                          type="number"
                          min={0}
                          step="0.01"
                          value={judgeOutputPrice}
                          onChange={(event) => setJudgeOutputPrice(Number(event.target.value))}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="eval-second-judge-provider">
                        {t("lab.scoring.secondJudgeProvider")}
                      </Label>
                      <Input
                        id="eval-second-judge-provider"
                        list="eval-provider-ids"
                        value={secondJudgeProvider}
                        onChange={(event) => {
                          const providerId = event.target.value
                          if (providerId !== secondJudgeProvider) setSecondJudgeModel("")
                          setSecondJudgeProvider(providerId)
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="eval-second-judge-model">
                        {t("lab.scoring.secondJudgeModel")}
                      </Label>
                      <Input
                        id="eval-second-judge-model"
                        list="eval-second-judge-models"
                        value={secondJudgeModel}
                        onChange={(event) => setSecondJudgeModel(event.target.value)}
                      />
                      <datalist id="eval-second-judge-models">
                        {modelOptions
                          .filter(
                            (option) =>
                              !secondJudgeProvider || option.providerId === secondJudgeProvider
                          )
                          .map((option) => (
                            <option
                              key={`${option.providerId}:${option.modelId}`}
                              value={option.modelId}
                              label={option.modelName}
                            />
                          ))}
                      </datalist>
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <span className="text-sm font-medium">{t("lab.scoring.secondJudgeLocal")}</span>
                    <Badge variant={secondJudgeIsLocal ? "default" : "secondary"}>
                      {secondJudgeIsLocal
                        ? t("lab.variants.localConfirmed")
                        : t("lab.variants.cloudOrUnverified")}
                    </Badge>
                  </div>
                  {!secondJudgeIsLocal ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <Label htmlFor="eval-second-judge-input-price">
                          {t("lab.scoring.secondJudgeInputPrice")}
                        </Label>
                        <Input
                          id="eval-second-judge-input-price"
                          type="number"
                          min={0}
                          step="0.01"
                          value={secondJudgeInputPrice}
                          onChange={(event) => setSecondJudgeInputPrice(Number(event.target.value))}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="eval-second-judge-output-price">
                          {t("lab.scoring.secondJudgeOutputPrice")}
                        </Label>
                        <Input
                          id="eval-second-judge-output-price"
                          type="number"
                          min={0}
                          step="0.01"
                          value={secondJudgeOutputPrice}
                          onChange={(event) =>
                            setSecondJudgeOutputPrice(Number(event.target.value))
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={calibration ? "default" : "secondary"}>
                      {calibration ? t("lab.scoring.calibrated") : t("lab.scoring.notCalibrated")}
                    </Badge>
                    {calibration ? (
                      <span className="text-xs text-muted-foreground">
                        {t("lab.scoring.calibrationMetrics", {
                          count: calibration.scoredCount,
                          kappa: calibration.metrics.cohenKappa ?? 0,
                          accuracy: calibration.metrics.accuracy ?? 0,
                        })}
                      </span>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => setLegacyTool("calibrate")}>
                      {t("lab.scoring.openCalibration")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{t("lab.scoring.dimensions")}</CardTitle>
                <CardDescription>{t("lab.scoring.dimensionsHint")}</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDecisionPolicy((current) => ({
                    ...current,
                    dimensions: [
                      ...current.dimensions,
                      { metric: "quality", direction: "maximize", weight: 0 },
                    ],
                  }))
                }
              >
                <PlusIcon />
                {t("lab.scoring.addDimension")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {decisionPolicy.dimensions.map((dimension, index) => (
                <div
                  key={`dimension-${index}`}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end"
                >
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-dimension-${index}-metric`}>
                      {t("lab.scoring.metric")}
                    </Label>
                    <Input
                      id={`eval-dimension-${index}-metric`}
                      value={dimension.metric}
                      onChange={(event) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          dimensions: current.dimensions.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, metric: event.target.value } : item
                          ),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-dimension-${index}-direction`}>
                      {t("lab.scoring.direction")}
                    </Label>
                    <NativeSelect
                      id={`eval-dimension-${index}-direction`}
                      wrapperClassName="w-full"
                      value={dimension.direction}
                      onChange={(event) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          dimensions: current.dimensions.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  direction: event.target.value as "maximize" | "minimize",
                                }
                              : item
                          ),
                        }))
                      }
                    >
                      <NativeSelectOption value="maximize">
                        {t("lab.scoring.maximize")}
                      </NativeSelectOption>
                      <NativeSelectOption value="minimize">
                        {t("lab.scoring.minimize")}
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-dimension-${index}-weight`}>
                      {t("lab.scoring.weight")}
                    </Label>
                    <ClampedNumberInput
                      id={`eval-dimension-${index}-weight`}
                      min={0}
                      max={WEIGHT_MAX}
                      step="0.05"
                      value={dimension.weight}
                      onCommit={(weight) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          dimensions: current.dimensions.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, weight } : item
                          ),
                        }))
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={decisionPolicy.dimensions.length <= 1}
                    aria-label={t("lab.scoring.removeDimension")}
                    onClick={() =>
                      setDecisionPolicy((current) => ({
                        ...current,
                        dimensions: current.dimensions.filter(
                          (_, itemIndex) => itemIndex !== index
                        ),
                      }))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{t("lab.scoring.constraints")}</CardTitle>
                <CardDescription>{t("lab.scoring.constraintsHint")}</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDecisionPolicy((current) => ({
                    ...current,
                    constraints: [
                      ...current.constraints,
                      { metric: "quality", operator: "gte", value: 0 },
                    ],
                  }))
                }
              >
                <PlusIcon />
                {t("lab.scoring.addConstraint")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {decisionPolicy.constraints.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("lab.scoring.noConstraints")}</p>
              ) : null}
              {decisionPolicy.constraints.map((constraint, index) => (
                <div
                  key={`constraint-${index}`}
                  className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_10rem_8rem_auto] sm:items-end"
                >
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-constraint-${index}-metric`}>
                      {t("lab.scoring.metric")}
                    </Label>
                    <Input
                      id={`eval-constraint-${index}-metric`}
                      value={constraint.metric}
                      onChange={(event) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          constraints: current.constraints.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, metric: event.target.value } : item
                          ),
                        }))
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-constraint-${index}-operator`}>
                      {t("lab.scoring.operator")}
                    </Label>
                    <NativeSelect
                      id={`eval-constraint-${index}-operator`}
                      wrapperClassName="w-full"
                      value={constraint.operator}
                      onChange={(event) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          constraints: current.constraints.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  operator: event.target.value as typeof constraint.operator,
                                }
                              : item
                          ),
                        }))
                      }
                    >
                      {(["gte", "lte", "gt", "lt"] as const).map((operator) => (
                        <NativeSelectOption key={operator} value={operator}>
                          {t(`lab.scoring.operators.${operator}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`eval-constraint-${index}-value`}>
                      {t("lab.scoring.value")}
                    </Label>
                    <ClampedNumberInput
                      id={`eval-constraint-${index}-value`}
                      min={-CONSTRAINT_VALUE_BOUND}
                      max={CONSTRAINT_VALUE_BOUND}
                      step="0.05"
                      value={constraint.value}
                      onCommit={(value) =>
                        setDecisionPolicy((current) => ({
                          ...current,
                          constraints: current.constraints.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, value } : item
                          ),
                        }))
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("lab.scoring.removeConstraint")}
                    onClick={() =>
                      setDecisionPolicy((current) => ({
                        ...current,
                        constraints: current.constraints.filter(
                          (_, itemIndex) => itemIndex !== index
                        ),
                      }))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="eval-confidence-level">{t("lab.scoring.confidence")}</Label>
                  <ClampedNumberInput
                    id="eval-confidence-level"
                    min={0.01}
                    max={0.99}
                    step="0.01"
                    value={decisionPolicy.confidenceLevel}
                    onCommit={(confidenceLevel) =>
                      setDecisionPolicy((current) => ({ ...current, confidenceLevel }))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="eval-minimum-cases">{t("lab.scoring.minimumCases")}</Label>
                  <ClampedNumberInput
                    id="eval-minimum-cases"
                    min={1}
                    max={CASE_COUNT_MAX}
                    step={1}
                    integer
                    value={decisionPolicy.minimumEffectiveCases}
                    onCommit={(minimumEffectiveCases) =>
                      setDecisionPolicy((current) => ({ ...current, minimumEffectiveCases }))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="eval-retention-days">{t("lab.scoring.retentionDays")}</Label>
                  <ClampedNumberInput
                    id="eval-retention-days"
                    min={1}
                    max={RETENTION_DAYS_MAX}
                    step={1}
                    integer
                    value={retentionDays}
                    onCommit={setRetentionDays}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }
    if (step === "preflight") {
      return (
        <div className="mx-auto w-full max-w-4xl space-y-5">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.preflight.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.preflight.description")}</p>
          </div>
          <Alert variant={preflight.ok ? "default" : "destructive"}>
            {preflight.ok ? <CheckCircle2Icon /> : <ShieldCheckIcon />}
            <AlertTitle>
              {preflight.ok ? t("lab.preflight.ready") : t("lab.preflight.blocked")}
            </AlertTitle>
            <AlertDescription>
              {preflight.ok ? t("lab.preflight.readyHint") : t("lab.preflight.blockedHint")}
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            {preflight.issues.map((issue, index) => (
              <div
                key={`${issue.code}-${issue.variantId ?? index}`}
                data-testid="preflight-issue"
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <Badge variant={issue.severity === "error" ? "destructive" : "secondary"}>
                  {issue.code}
                </Badge>
                <p className="text-sm text-muted-foreground">{issue.message}</p>
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (step === "run") {
      const progressValue = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0
      return (
        <div className="mx-auto w-full max-w-4xl space-y-5">
          <div>
            <h2 className="text-xl font-semibold">{t("lab.run.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("lab.run.description")}</p>
          </div>
          {runError ? (
            <Alert variant="destructive">
              <ShieldCheckIcon />
              <AlertTitle>{t("lab.run.error")}</AlertTitle>
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{t("lab.run.queue")}</CardTitle>
                  <CardDescription>{t(`lab.run.states.${queueState}`)}</CardDescription>
                </div>
                <Badge>{t(`lab.run.states.${queueState}`)}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={progressValue} aria-label={t("lab.run.progress")} />
              <p className="text-xs text-muted-foreground">
                {t("lab.run.taskProgress", {
                  completed: progress.completed,
                  total: progress.total,
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    controlPending ||
                    !preflight.ok ||
                    (["queued", "running", "paused"] as QueueState[]).includes(queueState)
                  }
                  onClick={() => void startExperiment()}
                >
                  <PlayIcon />
                  {t("lab.run.start")}
                </Button>
                <Button
                  variant="outline"
                  disabled={controlPending || queueState !== "running"}
                  onClick={() => void pauseExperiment()}
                >
                  <PauseIcon />
                  {t("lab.run.pause")}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    controlPending || (queueState !== "paused" && queueState !== "interrupted")
                  }
                  onClick={() => void resumeExperiment()}
                >
                  <RotateCcwIcon />
                  {t("lab.run.resume")}
                </Button>
                {queueState === "paused" ? (
                  <Button
                    variant="outline"
                    disabled={controlPending || budget <= progress.budgetCap}
                    onClick={() => void extendBudget()}
                  >
                    <CircleDollarSignIcon />
                    {t("lab.run.extendBudget")}
                  </Button>
                ) : null}
                <Button
                  variant="destructive"
                  disabled={
                    controlPending ||
                    !(["queued", "running", "paused", "interrupted"] as QueueState[]).includes(
                      queueState
                    )
                  }
                  onClick={() => void cancelExperiment()}
                >
                  <SquareIcon />
                  {t("lab.run.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="py-4">
              <CardContent>
                <p className="text-xs text-muted-foreground">{t("lab.run.spent")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {format.number(progress.spentCost, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4,
                  })}
                </p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <p className="text-xs text-muted-foreground">{t("lab.run.reserved")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {format.number(progress.reservedCost, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4,
                  })}
                </p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <p className="text-xs text-muted-foreground">{t("lab.run.cap")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {format.number(progress.budgetCap || budget, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )
    }
    const recommendation = reportView?.recommendation?.result
    const recommendedVariant = reportView?.experiment.manifest.variants.find(
      (variant) => variant.id === recommendation?.recommendedVariantId
    )
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div>
          <h2 className="text-xl font-semibold">{t("lab.review.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("lab.review.description")}</p>
        </div>
        <Alert>
          <FileCheck2Icon />
          <AlertTitle>
            {recommendation?.status === "recommended"
              ? t("lab.review.recommended", {
                  variant:
                    recommendedVariant?.name ??
                    recommendation.recommendedVariantId ??
                    t("lab.project.untitled"),
                })
              : t("lab.review.noConclusion")}
          </AlertTitle>
          <AlertDescription>
            {recommendation?.status === "no_conclusion" && recommendation.reason
              ? t(`lab.review.reasons.${recommendation.reason}`)
              : recommendation?.status === "recommended"
                ? t("lab.review.recommendedHint")
                : t("lab.review.noConclusionHint")}
          </AlertDescription>
        </Alert>
        {reportView && experimentId ? (
          <BlindReviewPanel
            experimentId={experimentId}
            cases={reportView.cases}
            artifactKey={artifactKey}
            seed={reportView.experiment.manifest.randomSeed}
            onRecommendationChanged={() => refreshReport(experimentId)}
          />
        ) : null}
        {recommendation?.status === "recommended" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("lab.review.apply.title")}</CardTitle>
              <CardDescription>{t("lab.review.apply.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {applicationError ? (
                <Alert variant="destructive">
                  <ShieldCheckIcon />
                  <AlertTitle>{t("lab.review.apply.error")}</AlertTitle>
                  <AlertDescription>{applicationError}</AlertDescription>
                </Alert>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="eval-apply-target-type">{t("lab.review.apply.targetType")}</Label>
                  <NativeSelect
                    id="eval-apply-target-type"
                    wrapperClassName="w-full"
                    disabled={applicationPending}
                    value={applicationTarget.targetType}
                    onChange={(event) => {
                      const targetType = event.target.value as EvalConfigurationTarget["targetType"]
                      setApplicationTarget({
                        targetType,
                        targetId:
                          targetType === "default-model" || targetType === "routing-policy"
                            ? "global"
                            : "",
                      })
                      setApplicationDiff([])
                      setApplication(null)
                      setApplicationError(null)
                    }}
                  >
                    <NativeSelectOption value="default-model">
                      {t("lab.review.apply.targets.default-model")}
                    </NativeSelectOption>
                    <NativeSelectOption value="character">
                      {t("lab.review.apply.targets.character")}
                    </NativeSelectOption>
                    <NativeSelectOption value="workflow">
                      {t("lab.review.apply.targets.workflow")}
                    </NativeSelectOption>
                    <NativeSelectOption value="routing-policy">
                      {t("lab.review.apply.targets.routing-policy")}
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="eval-apply-target-id">{t("lab.review.apply.targetId")}</Label>
                  <Input
                    id="eval-apply-target-id"
                    list={
                      applicationTarget.targetType === "character"
                        ? "eval-apply-character-targets"
                        : applicationTarget.targetType === "workflow"
                          ? "eval-apply-workflow-targets"
                          : undefined
                    }
                    disabled={
                      applicationPending ||
                      applicationTarget.targetType === "default-model" ||
                      applicationTarget.targetType === "routing-policy"
                    }
                    value={applicationTarget.targetId}
                    onChange={(event) => {
                      setApplicationTarget({ ...applicationTarget, targetId: event.target.value })
                      setApplicationDiff([])
                      setApplication(null)
                      setApplicationError(null)
                    }}
                  />
                  <datalist id="eval-apply-character-targets">
                    {(runOptions.characters ?? []).map((option) => (
                      <option key={option.id} value={option.id} label={option.name} />
                    ))}
                  </datalist>
                  <datalist id="eval-apply-workflow-targets">
                    {(runOptions.workflows ?? []).map((option) => (
                      <option key={option.id} value={option.id} label={option.name} />
                    ))}
                  </datalist>
                </div>
              </div>
              {!recommendedConfiguration ? (
                <Alert>
                  <ShieldCheckIcon />
                  <AlertTitle>{t("lab.review.apply.configurationMissing")}</AlertTitle>
                  <AlertDescription>
                    {t("lab.review.apply.configurationMissingHint")}
                  </AlertDescription>
                </Alert>
              ) : null}
              {applicationDiff.length ? (
                <div className="overflow-hidden rounded-lg border">
                  <Table className="text-sm">
                    <TableHeader>
                      <TableRow className="text-muted-foreground hover:bg-transparent">
                        <TableHead className="p-2">{t("lab.review.apply.field")}</TableHead>
                        <TableHead className="p-2">{t("lab.review.apply.before")}</TableHead>
                        <TableHead className="p-2">{t("lab.review.apply.after")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {applicationDiff.map((entry) => (
                        <TableRow key={entry.path}>
                          <TableCell className="p-2 font-mono text-xs">{entry.path}</TableCell>
                          <TableCell className="p-2 font-mono text-xs">
                            {JSON.stringify(entry.before)}
                          </TableCell>
                          <TableCell className="p-2 font-mono text-xs">
                            {JSON.stringify(entry.after)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={
                    applicationPending || !recommendedConfiguration || !applicationTarget.targetId
                  }
                  onClick={() => void previewApplication()}
                >
                  {t("lab.review.apply.preview")}
                </Button>
                <Button
                  disabled={applicationPending || !applicationDiff.length || Boolean(application)}
                  onClick={() => void applyRecommendation()}
                >
                  {t("lab.review.apply.confirm")}
                </Button>
                <Button
                  variant="outline"
                  disabled={applicationPending || !application || Boolean(application.rolledBackAt)}
                  onClick={() => void rollbackApplication()}
                >
                  <RotateCcwIcon />
                  {t("lab.review.apply.rollback")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
        {reportView ? (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t("lab.review.frontier")}</CardTitle>
                  <CardDescription>{t("lab.review.frontierHint")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {reportView.experiment.manifest.variants.map((variant) => (
                    <div
                      key={variant.id}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <span className="font-medium">{variant.name}</span>
                      <Badge
                        variant={
                          recommendation?.paretoVariantIds.includes(variant.id)
                            ? "default"
                            : "secondary"
                        }
                      >
                        {recommendation?.paretoVariantIds.includes(variant.id)
                          ? t("lab.review.onFrontier")
                          : t("lab.review.dominated")}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>{t("lab.review.costSummary")}</CardTitle>
                  <CardDescription>{t("lab.review.costSummaryHint")}</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("lab.review.actualCost")}</p>
                    <p className="mt-1 font-semibold">
                      {format.number(reportView.cost.actual, {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 4,
                        maximumFractionDigits: 4,
                      })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("lab.review.estimatedCost")}</p>
                    <p className="mt-1 font-semibold">
                      {format.number(reportView.cost.estimatedWorstCase, {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 4,
                        maximumFractionDigits: 4,
                      })}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("lab.run.cap")}</p>
                    <p className="mt-1 font-semibold">
                      {format.number(reportView.cost.hardCap, {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>{t("lab.review.confidence")}</CardTitle>
                <CardDescription>{t("lab.review.confidenceHint")}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table className="min-w-[640px] text-sm">
                  <TableHeader>
                    <TableRow className="text-muted-foreground hover:bg-transparent">
                      <TableHead className="p-2">{t("lab.review.variant")}</TableHead>
                      <TableHead className="p-2">{t("lab.scoring.metrics.quality")}</TableHead>
                      <TableHead className="p-2">{t("lab.scoring.metrics.reliability")}</TableHead>
                      <TableHead className="p-2">{t("lab.scoring.metrics.cost")}</TableHead>
                      <TableHead className="p-2">{t("lab.scoring.metrics.latency")}</TableHead>
                      <TableHead className="p-2">{t("lab.review.effectiveCases")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reportView.evidence.map((candidate) => {
                      const variant = reportView.experiment.manifest.variants.find(
                        (item) => item.id === candidate.variantId
                      )
                      return (
                        <TableRow key={candidate.variantId}>
                          <TableCell className="p-2 font-medium">
                            {variant?.name ?? candidate.variantId}
                          </TableCell>
                          <TableCell className="p-2 tabular-nums">
                            {candidate.metrics.quality.toFixed(3)} [
                            {candidate.intervals.quality.low.toFixed(3)},{" "}
                            {candidate.intervals.quality.high.toFixed(3)}]
                          </TableCell>
                          <TableCell className="p-2 tabular-nums">
                            {candidate.metrics.reliability.toFixed(3)}
                          </TableCell>
                          <TableCell className="p-2 tabular-nums">
                            {candidate.metrics.cost.toFixed(3)}
                          </TableCell>
                          <TableCell className="p-2 tabular-nums">
                            {candidate.metrics.latency.toFixed(3)}
                          </TableCell>
                          <TableCell className="p-2 tabular-nums">
                            {candidate.effectiveCases}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            {reportView.providerErrors.length ? (
              <Alert variant="destructive">
                <ShieldCheckIcon />
                <AlertTitle>{t("lab.review.providerErrors")}</AlertTitle>
                <AlertDescription>
                  {t("lab.review.providerErrorsHint", { count: reportView.providerErrors.length })}
                </AlertDescription>
              </Alert>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>{t("lab.review.caseEvidence")}</CardTitle>
                <CardDescription>{t("lab.review.caseEvidenceHint")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="eval-report-variant-filter">
                      {t("lab.review.filterVariant")}
                    </Label>
                    <NativeSelect
                      id="eval-report-variant-filter"
                      wrapperClassName="w-full"
                      value={reportVariant}
                      onChange={(event) => setReportVariant(event.target.value)}
                    >
                      <NativeSelectOption value="">
                        {t("lab.review.allVariants")}
                      </NativeSelectOption>
                      {reportView.experiment.manifest.variants.map((variant) => (
                        <NativeSelectOption key={variant.id} value={variant.id}>
                          {variant.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="eval-report-status-filter">
                      {t("lab.review.filterStatus")}
                    </Label>
                    <NativeSelect
                      id="eval-report-status-filter"
                      wrapperClassName="w-full"
                      value={reportStatus}
                      onChange={(event) => setReportStatus(event.target.value)}
                    >
                      <NativeSelectOption value="">
                        {t("lab.review.allStatuses")}
                      </NativeSelectOption>
                      <NativeSelectOption value="passed">
                        {t("lab.review.statuses.passed")}
                      </NativeSelectOption>
                      <NativeSelectOption value="failed">
                        {t("lab.review.statuses.failed")}
                      </NativeSelectOption>
                      <NativeSelectOption value="errored">
                        {t("lab.review.statuses.errored")}
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                </div>
                <div className="space-y-3">
                  {filteredReportCases.map((item) => (
                    <Collapsible
                      key={item.sampleId}
                      className="group/collapsible rounded-lg border p-3"
                    >
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          className="h-auto w-full justify-between p-0 text-left font-medium"
                        >
                          <span>
                            {item.case.id} ·{" "}
                            {reportView.experiment.manifest.variants.find(
                              (variant) => variant.id === item.variantId
                            )?.name ?? item.variantId}{" "}
                            · {t(`lab.review.statuses.${item.status}`)}
                          </span>
                          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-180" />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-3 grid gap-3 text-sm">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("lab.review.input")}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">{item.case.input}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("lab.review.output")}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">{item.sample.output}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {item.scores.map((score) => (
                            <Badge
                              key={score.id}
                              variant={score.passed ? "default" : "destructive"}
                            >
                              {score.scorerId}: {score.value.toFixed(2)}
                            </Badge>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <div className="grid h-40 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
            {t("lab.review.awaitingEvidence")}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="eval-lab-workspace"
    >
      <FeaturePageHeader
        icon={<ScaleIcon />}
        title={t("lab.title")}
        description={t("lab.subtitle")}
        status={<Badge variant="outline">{t(`lab.run.states.${queueState}`)}</Badge>}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEvidenceOpen(true)}
              aria-label={t("lab.evidence.open")}
              className="lg:hidden"
            >
              <PanelRightIcon />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label={t("lab.legacy.open")}>
                  <MoreHorizontalIcon />
                  <span className="hidden sm:inline">{t("lab.legacy.open")}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setLegacyTool("datasets")}>
                  <DatabaseIcon />
                  {t("tabs.datasets")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLegacyTool("compare")}>
                  <GitCompareIcon />
                  {t("tabs.compare")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLegacyTool("annotate")}>
                  <MicroscopeIcon />
                  {t("tabs.annotate")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setLegacyTool("calibrate")}>
                  <ScaleIcon />
                  {t("tabs.calibrate")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("settings.title")}
              onClick={() => router.push("/settings?section=eval")}
            >
              <SettingsIcon />
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <nav
          aria-label={t("lab.steps.label")}
          className="hidden w-56 shrink-0 flex-col border-r bg-muted/10 p-3 md:flex xl:w-64"
        >
          <div className="mb-3 px-2">
            <p className="truncate text-sm font-medium">{project.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t(`lab.mode.${mode}`)}</p>
          </div>
          <div className="space-y-1">
            {STEPS.map((item, index) => {
              const Icon = STEP_ICONS[item]
              return (
                <Button
                  key={item}
                  ref={(node) => {
                    stepRefs.current[index] = node
                  }}
                  variant={step === item && !legacyTool ? "secondary" : "ghost"}
                  className="w-full justify-start"
                  aria-label={t(`lab.steps.${item}`)}
                  aria-current={step === item ? "step" : undefined}
                  onClick={() => changeStep(item)}
                  onKeyDown={(event) => onStepKeyDown(event, index)}
                >
                  <span className="grid size-5 place-items-center rounded-full border text-[10px] tabular-nums">
                    {index + 1}
                  </span>
                  <Icon className="size-4" />
                  {t(`lab.steps.${item}`)}
                </Button>
              )
            })}
          </div>
          <div className="mt-auto rounded-lg border bg-background p-3">
            <p className="text-xs font-medium">{t("lab.rail.evidence")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("lab.rail.evidenceHint", { count: preflight.issues.length })}
            </p>
          </div>
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {legacyTool ? (
            renderLegacy()
          ) : (
            <div
              key={step}
              data-testid="eval-lab-canvas"
              className="motion-safe:transition-opacity motion-safe:duration-200 h-full overflow-y-auto overscroll-contain px-4 py-5 pb-24 sm:px-6 md:pb-6 xl:px-8"
            >
              {actionError ? (
                <Alert variant="destructive" className="mx-auto mb-4 max-w-5xl">
                  <ShieldCheckIcon />
                  <AlertTitle>{t("lab.actions.error")}</AlertTitle>
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              ) : null}
              {renderStep()}
            </div>
          )}
        </main>

        <aside
          data-testid="eval-evidence-panel"
          className="hidden w-72 shrink-0 resize-x overflow-auto border-l bg-background lg:block xl:w-80"
        >
          <div className="sticky top-0 border-b bg-background/90 p-4 backdrop-blur">
            <div className="flex items-center gap-2">
              <ActivityIcon className="size-4 text-primary" />
              <h2 className="font-semibold">{t("lab.evidence.title")}</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("lab.evidence.description")}</p>
          </div>
          <EvidenceContent
            issueCount={preflight.issues.length}
            retentionDays={project.retentionDays}
            mediaClearance={project.privacyPolicy.mediaClearance}
          />
        </aside>
      </div>

      {!legacyTool && (
        <div
          data-testid="eval-lab-mobile-actions"
          className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={currentIndex === 0}
            onClick={() => changeStep(STEPS[currentIndex - 1])}
          >
            <ChevronLeftIcon />
            {t("lab.actions.back")}
          </Button>
          <div className="min-w-0 flex-1 text-center text-xs text-muted-foreground">
            {currentIndex + 1} / {STEPS.length}
          </div>
          <Button
            size="sm"
            disabled={currentIndex === STEPS.length - 1}
            onClick={() => changeStep(STEPS[currentIndex + 1])}
          >
            {t("lab.actions.next")}
            <ChevronRightIcon />
          </Button>
        </div>
      )}

      <Sheet open={evidenceOpen} onOpenChange={setEvidenceOpen}>
        <SheetContent side="bottom" className="max-h-[82dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("lab.evidence.title")}</SheetTitle>
            <SheetDescription>{t("lab.evidence.description")}</SheetDescription>
          </SheetHeader>
          <EvidenceContent
            issueCount={preflight.issues.length}
            retentionDays={project.retentionDays}
            mediaClearance={project.privacyPolicy.mediaClearance}
          />
        </SheetContent>
      </Sheet>
    </div>
  )
}
