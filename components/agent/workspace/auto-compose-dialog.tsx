"use client"

/**
 * Auto-compose dialog (ADR-0022 follow-up).
 *
 * Turns a single objective into a runnable Agent Team. The flow has four
 * phases:
 *
 *   input → (clarify) → loading → preview
 *
 * - **input**: the objective plus a collapsible advanced panel (team size,
 *   forced execution pattern, run options, clarify toggle). Two CTAs —
 *   "Generate plan" (→ optional clarify → preview) and "Quick create" (plan
 *   with the current options, then materialize immediately, skipping preview).
 * - **clarify**: when enabled and the objective is vague, the engine's
 *   `clarifyObjective` pre-stage returns 1–3 questions; the operator answers
 *   (optional) and the answers are folded back into the objective.
 * - **preview**: an EDITABLE copy of the proposal — roster, task graph, name,
 *   and pattern. All edits mutate the local copy; nothing re-hits the model.
 *
 * Nothing runs until approval (or an explicit Quick create) — the HITL gate the
 * plan calls for. The LLM client, engine, clarify stage, and capability catalog
 * are injectable so the dialog is unit-testable without a provider key or the
 * live store.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon, ZapIcon } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { useSettingsStore } from "@/stores/settings/settings-store"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import {
  AutoOrchestrationPiiError,
  planAutoOrchestration,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { applyClarifications, clarifyObjective } from "@/lib/ai/agent/team/auto/clarify-objective"
import {
  addMember,
  addTask,
  removeMember,
  removeTask,
  setLead,
} from "@/lib/ai/agent/team/auto/edit-proposal"
import {
  EMPTY_CAPABILITY_CATALOG,
  gatherCapabilityCatalog,
} from "@/lib/ai/agent/team/auto/capability-catalog"
import { materializeProposal } from "@/lib/ai/agent/team/auto/materialize"
import {
  materializeBackgroundHandoff,
  materializeExternalHandoff,
} from "@/lib/ai/agent/team/auto/handoff"
import {
  runCouncilFromProposal,
  runEnsembleFromProposal,
  type RunExecutorDeps,
} from "@/lib/ai/agent/team/auto/run-executor"
import { defaultCouncilRunPrompt } from "@/lib/ai/council/run-council"
import type { AutoOrchestrationProposal, CapabilityCatalog } from "@/lib/ai/agent/team/auto/types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AgentTeamConfig, TeamExecutionPattern } from "@/types/agent/agent-team"
import { createLogger } from "@cognia/logging"

import {
  AutoComposeAdvancedOptions,
  DEFAULT_AUTO_COMPOSE_OPTIONS,
  type AutoComposeOptions,
} from "./auto-compose-advanced-options"
import { AutoComposeClarifyStep } from "./auto-compose-clarify-step"
import { AutoComposeRosterEditor } from "./auto-compose-roster-editor"
import { AutoComposeTaskEditor } from "./auto-compose-task-editor"

const log = createLogger("agentTeams.autoCompose")

const PREVIEW_PATTERNS: readonly TeamExecutionPattern[] = [
  "manager_worker",
  "parallel_specialists",
  "background_handoff",
  "external_handoff",
  "single_agent_recommended",
  "ultracode_orchestration",
]

export interface AutoComposeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new team id after the operator approves (or quick-creates). */
  onComposed: (teamId: string) => void
  /** Called with the markdown report after a council/ensemble executor runs
   * in-dialog, so a chat-hosted trigger can forward it into the transcript. */
  onResult?: (markdown: string) => void
  // ── injectable seams (default to the real impls; faked in tests) ──
  plan?: typeof planAutoOrchestration
  materialize?: typeof materializeProposal
  materializeBackground?: typeof materializeBackgroundHandoff
  materializeExternal?: typeof materializeExternalHandoff
  buildClient?: () => LlmClient | null
  clarify?: typeof clarifyObjective
  getCatalog?: () => Promise<CapabilityCatalog>
  runCouncilExec?: typeof runCouncilFromProposal
  runEnsembleExec?: typeof runEnsembleFromProposal
  /** Enabled routing aliases (defaults to the settings model-mappings). */
  loadAliases?: () => Promise<string[]>
  /** Routed prompt runner factory (defaults to the ADR-0043 engine). */
  makeRunPrompt?: () => Promise<RunExecutorDeps["runPrompt"]>
}

type Phase = "input" | "clarify" | "loading" | "preview" | "result"

export function AutoComposeDialog({
  open,
  onOpenChange,
  onComposed,
  onResult,
  plan = planAutoOrchestration,
  materialize = materializeProposal,
  materializeBackground = materializeBackgroundHandoff,
  materializeExternal = materializeExternalHandoff,
  buildClient,
  clarify = clarifyObjective,
  getCatalog = gatherCapabilityCatalog,
  runCouncilExec = runCouncilFromProposal,
  runEnsembleExec = runEnsembleFromProposal,
  loadAliases,
  makeRunPrompt,
}: AutoComposeDialogProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")
  const appSettings = useSettingsStore((s) => s.settings)

  const [phase, setPhase] = useState<Phase>("input")
  const [objective, setObjective] = useState("")
  const [options, setOptions] = useState<AutoComposeOptions>(DEFAULT_AUTO_COMPOSE_OPTIONS)
  const [teamName, setTeamName] = useState("")
  const [proposal, setProposal] = useState<AutoOrchestrationProposal | null>(null)
  const [catalog, setCatalog] = useState<CapabilityCatalog>(EMPTY_CAPABILITY_CATALOG)
  const [questions, setQuestions] = useState<string[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [resultMarkdown, setResultMarkdown] = useState<string | null>(null)

  const resolveClient = useMemo(
    () =>
      buildClient ??
      (() =>
        buildRendererLlmClient({
          session: null,
          appSettings,
          featureId: "agent-team-auto",
        })),
    [buildClient, appSettings]
  )

  const reset = () => {
    setPhase("input")
    setObjective("")
    setOptions(DEFAULT_AUTO_COMPOSE_OPTIONS)
    setTeamName("")
    setProposal(null)
    setCatalog(EMPTY_CAPABILITY_CATALOG)
    setQuestions([])
    setAnswers([])
    setResultMarkdown(null)
  }

  const isBusy = phase === "loading"

  /** The consensus/verify signal the operator chose (opts into council/ensemble). */
  const consensusSignal = {
    ...(options.consensusNeeded ? { consensusNeeded: true } : {}),
    ...(options.verificationNeeded ? { verificationNeeded: true } : {}),
  }

  /** Alias source for in-dialog council/ensemble runs. */
  const resolveAliases =
    loadAliases ??
    (async () =>
      (appSettings?.modelMappings ?? [])
        .filter((m) => m && m.enabled !== false && m.alias)
        .map((m) => m.alias))

  /** Build the run-option config the operator chose for team creation. */
  const buildConfig = (): Partial<AgentTeamConfig> => ({
    requirePlanApproval: options.requirePlanApproval,
    ...(options.ultracode ? { ultracode: { enabled: true } } : {}),
  })

  /** Validate the objective + resolve a client, toasting + returning null on failure. */
  const prepare = (): { trimmed: string; client: LlmClient } | null => {
    const trimmed = objective.trim()
    if (!trimmed) {
      toast.error(t("objectiveRequired"))
      return null
    }
    const client = resolveClient()
    if (!client) {
      toast.error(t("noClient"))
      return null
    }
    return { trimmed, client }
  }

  const safeCatalog = async (): Promise<CapabilityCatalog> => {
    try {
      return await getCatalog()
    } catch {
      return EMPTY_CAPABILITY_CATALOG
    }
  }

  const handlePlanError = (err: unknown) => {
    setPhase("input")
    if (err instanceof AutoOrchestrationPiiError) {
      toast.error(t("piiRefused"))
    } else {
      log.error("auto_compose_failed", err)
      toast.error(t("failed", { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  /** Run a non-team (council/ensemble) executor in-dialog and show its report. */
  const runAnalysisExecutor = async (
    p: AutoOrchestrationProposal,
    kind: "council" | "ensemble"
  ) => {
    setPhase("loading")
    try {
      const runPrompt = await (makeRunPrompt ?? defaultCouncilRunPrompt)()
      const deps: RunExecutorDeps = { loadAliases: resolveAliases, runPrompt }
      const res =
        kind === "council" ? await runCouncilExec(p, deps) : await runEnsembleExec(p, deps)
      setResultMarkdown(res.markdown)
      setPhase("result")
      onResult?.(res.markdown)
      log.info("auto_compose_executor_ran", { kind, ok: res.ok })
    } catch (err) {
      handlePlanError(err)
    }
  }

  /** Plan from `objectiveText` and open the editable preview. */
  const doPlan = async (objectiveText: string, client: LlmClient) => {
    setPhase("loading")
    try {
      const cat = await safeCatalog()
      const next = await plan({
        objective: objectiveText,
        client,
        catalog: cat,
        maxRoster: options.maxRoster,
        preferredPattern:
          options.preferredPattern === "auto" ? undefined : options.preferredPattern,
        consensusSignal,
      })
      setProposal(next)
      setCatalog(cat)
      setTeamName(next.objective.slice(0, 60))
      setPhase("preview")
      log.info("auto_compose_planned", {
        roster: next.roster.length,
        tasks: next.tasks.length,
        pattern: next.assessment.recommendedPattern,
      })
    } catch (err) {
      handlePlanError(err)
    }
  }

  /** "Generate plan": optionally clarify first, then plan → preview. */
  const handleGenerate = async () => {
    const ready = prepare()
    if (!ready) return
    if (options.clarifyEnabled) {
      setPhase("loading")
      try {
        const result = await clarify({ objective: ready.trimmed, client: ready.client, max: 3 })
        if (result.questions.length > 0) {
          setQuestions(result.questions)
          setAnswers(result.questions.map(() => ""))
          setPhase("clarify")
          return
        }
      } catch (err) {
        // Clarify shares the fail-closed PII gate; surface that distinctly.
        if (err instanceof AutoOrchestrationPiiError) {
          handlePlanError(err)
          return
        }
        // Any other clarify failure is non-fatal — fall through to planning.
      }
    }
    await doPlan(ready.trimmed, ready.client)
  }

  /** Continue from the clarify step, folding answers into the objective. */
  const handleClarifyContinue = async () => {
    const client = resolveClient()
    if (!client) {
      toast.error(t("noClient"))
      return
    }
    const refined = applyClarifications(
      objective.trim(),
      questions.map((q, i) => ({ question: q, answer: answers[i] ?? "" }))
    )
    await doPlan(refined, client)
  }

  /** Skip clarification and plan from the original objective. */
  const handleClarifySkip = async () => {
    const client = resolveClient()
    if (!client) {
      toast.error(t("noClient"))
      return
    }
    await doPlan(objective.trim(), client)
  }

  /**
   * Handoff executors — background queues a one-shot scheduler run, external
   * marks the team awaiting pickup via the bridge. Both still materialize a
   * real team; the dialog's `materialize` seam is threaded so tests stay
   * store-free.
   */
  const runHandoffExecutor = async (
    next: AutoOrchestrationProposal,
    kind: "background-handoff" | "external-handoff",
    name?: string
  ): Promise<void> => {
    const opts = { name, config: buildConfig() }
    if (kind === "background-handoff") {
      const r = await materializeBackground(next, opts, { materialize })
      log.info("auto_compose_background_handoff", {
        teamId: r.teamId,
        scheduledTaskId: r.scheduledTaskId,
      })
      toast.success(t(r.scheduledTaskId ? "queuedBackground" : "queuedBackgroundNoScheduler"))
      onComposed(r.teamId)
      reset()
      return
    }
    const r = await materializeExternal(next, opts, { materialize })
    log.info("auto_compose_external_handoff", { teamId: r.teamId })
    toast.success(t("awaitingExternal"))
    onComposed(r.teamId)
    reset()
  }

  /** "Quick create": plan with smart defaults and materialize immediately. */
  const handleQuickCreate = async () => {
    const ready = prepare()
    if (!ready) return
    setPhase("loading")
    try {
      const cat = await safeCatalog()
      const next = await plan({
        objective: ready.trimmed,
        client: ready.client,
        catalog: cat,
        maxRoster: options.maxRoster,
        preferredPattern:
          options.preferredPattern === "auto" ? undefined : options.preferredPattern,
        consensusSignal,
      })
      const kind = next.executor?.kind
      if (kind === "council" || kind === "ensemble") {
        await runAnalysisExecutor(next, kind)
        return
      }
      if (kind === "background-handoff" || kind === "external-handoff") {
        await runHandoffExecutor(next, kind)
        return
      }
      const { teamId } = materialize(next, { config: buildConfig() })
      log.info("auto_compose_quick_created", { teamId })
      toast.success(t("created"))
      onComposed(teamId)
      reset()
    } catch (err) {
      handlePlanError(err)
    }
  }

  const handleApprove = async () => {
    if (!proposal) return
    const kind = proposal.executor?.kind
    // Council / ensemble aren't teams — run them here and surface the report
    // rather than materializing a team. Handoffs materialize AND queue/mark
    // (background → one-shot scheduler run; external → awaiting bridge
    // pickup). Everything else materializes as before (single-send lands as
    // a 1-member team; team-* run from the workspace).
    if (kind === "council" || kind === "ensemble") {
      await runAnalysisExecutor(proposal, kind)
      return
    }
    if (kind === "background-handoff" || kind === "external-handoff") {
      await runHandoffExecutor(proposal, kind, teamName.trim() || undefined)
      return
    }
    const { teamId } = materialize(proposal, {
      name: teamName.trim() || undefined,
      config: buildConfig(),
    })
    log.info("auto_compose_materialized", { teamId })
    toast.success(t("created"))
    onComposed(teamId)
    reset()
  }

  const updateProposal = (patch: Partial<AutoOrchestrationProposal>) =>
    setProposal((prev) => (prev ? { ...prev, ...patch } : prev))

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-2xl" data-testid="auto-compose-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {phase === "input" || phase === "loading" ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">{t("objectiveLabel")}</Label>
              <Textarea
                rows={4}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder={t("objectivePlaceholder")}
                className="text-sm"
                disabled={isBusy}
                data-testid="auto-compose-objective"
              />
            </div>
            <AutoComposeAdvancedOptions options={options} onChange={setOptions} disabled={isBusy} />
          </div>
        ) : phase === "clarify" ? (
          <AutoComposeClarifyStep
            questions={questions}
            answers={answers}
            onAnswerChange={(i, v) => setAnswers((prev) => prev.map((a, j) => (j === i ? v : a)))}
          />
        ) : phase === "result" ? (
          <div
            className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md border p-3 text-xs"
            data-testid="auto-compose-result"
          >
            {resultMarkdown ?? ""}
          </div>
        ) : proposal ? (
          <div
            className="space-y-4 max-h-[60vh] overflow-y-auto pr-1"
            data-testid="auto-compose-preview"
          >
            {/* Assessment + editable pattern */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {t("confidence", {
                    pct: Math.round(proposal.assessment.confidence * 100),
                  })}
                </Badge>
                <Select
                  value={proposal.assessment.recommendedPattern}
                  onValueChange={(v) =>
                    updateProposal({
                      assessment: {
                        ...proposal.assessment,
                        recommendedPattern: v as TeamExecutionPattern,
                      },
                    })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="ml-auto h-7 w-auto text-xs"
                    data-testid="auto-compose-preview-pattern"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREVIEW_PATTERNS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`patterns.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">{proposal.assessment.reason}</p>
              {proposal.executor ? (
                <div className="flex items-center gap-2" data-testid="auto-compose-executor">
                  <Badge variant="secondary" className="text-[10px]">
                    {t("executorLabel", {
                      executor: t(`executors.${proposal.executor.kind}`),
                    })}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {proposal.executor.reason}
                  </span>
                </div>
              ) : null}
            </div>

            <AutoComposeRosterEditor
              roster={proposal.roster}
              catalog={catalog}
              twinRoster={proposal.twinRoster ?? []}
              onChange={(roster) => updateProposal({ roster })}
              onAdd={() => updateProposal({ roster: addMember(proposal.roster) })}
              onRemove={(i) => {
                const next = removeMember(proposal.roster, proposal.tasks, i)
                updateProposal({ roster: next.roster, tasks: next.tasks })
              }}
              onSetLead={(i) => {
                const next = setLead(proposal.roster, proposal.tasks, i)
                updateProposal({ roster: next.roster, tasks: next.tasks })
              }}
            />

            <AutoComposeTaskEditor
              tasks={proposal.tasks}
              roster={proposal.roster}
              onChange={(tasks) => updateProposal({ tasks })}
              onAdd={() => updateProposal({ tasks: addTask(proposal.tasks) })}
              onRemove={(i) => updateProposal({ tasks: removeTask(proposal.tasks, i) })}
            />

            {/* Editable team name */}
            <div className="space-y-1">
              <Label className="text-xs">{t("teamNameLabel")}</Label>
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder={t("teamNamePlaceholder")}
                data-testid="auto-compose-name"
              />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {phase === "preview" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPhase("input")}
                data-testid="auto-compose-reject"
              >
                {t("reject")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleApprove()}
                data-testid="auto-compose-approve"
              >
                {t("approve")}
              </Button>
            </>
          ) : phase === "result" ? (
            <Button
              size="sm"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
              data-testid="auto-compose-result-done"
            >
              {t("resultDone")}
            </Button>
          ) : phase === "clarify" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleClarifySkip()}
                data-testid="auto-compose-clarify-skip"
              >
                {t("clarifySkip")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleClarifyContinue()}
                data-testid="auto-compose-clarify-continue"
              >
                {t("clarifyContinue")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleQuickCreate()}
                disabled={isBusy}
                data-testid="auto-compose-quick"
              >
                <ZapIcon className="mr-1.5 size-3.5" />
                {t("quickCreate")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleGenerate()}
                disabled={isBusy}
                data-testid="auto-compose-submit"
              >
                {isBusy ? (
                  <>
                    <Loader2Icon className="mr-2 size-3.5 animate-spin" />
                    {t("composing")}
                  </>
                ) : (
                  t("compose")
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
