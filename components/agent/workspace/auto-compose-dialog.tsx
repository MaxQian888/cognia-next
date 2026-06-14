"use client"

/**
 * Auto-compose dialog (ADR-0022 follow-up).
 *
 * Turns a single objective into a runnable Agent Team: the pure engine
 * (`lib/ai/agent/team/auto`) assesses routing, composes a specialist roster,
 * and decomposes a task DAG; the operator reviews the proposal here and either
 * approves (→ `materializeProposal` into the store, then open the workspace) or
 * rejects (→ back to the objective). Nothing runs until approval — this is the
 * HITL gate the plan calls for.
 *
 * The LLM client and engine are injectable so the dialog is unit-testable
 * without a provider key or the live store.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SparklesIcon, UsersIcon } from "lucide-react"
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

import { useSettingsStore } from "@/stores/settings/settings-store"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import {
  AutoOrchestrationPiiError,
  planAutoOrchestration,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { materializeProposal } from "@/lib/ai/agent/team/auto/materialize"
import type { AutoOrchestrationProposal } from "@/lib/ai/agent/team/auto/types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { createLogger } from "@/lib/logging"

const log = createLogger("agentTeams.autoCompose")

export interface AutoComposeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new team id after the operator approves the proposal. */
  onComposed: (teamId: string) => void
  // ── injectable seams (default to the real impls; faked in tests) ──
  plan?: typeof planAutoOrchestration
  materialize?: typeof materializeProposal
  buildClient?: () => LlmClient | null
}

type Phase = "input" | "loading" | "preview"

export function AutoComposeDialog({
  open,
  onOpenChange,
  onComposed,
  plan = planAutoOrchestration,
  materialize = materializeProposal,
  buildClient,
}: AutoComposeDialogProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")
  const appSettings = useSettingsStore((s) => s.settings)

  const [phase, setPhase] = useState<Phase>("input")
  const [objective, setObjective] = useState("")
  const [teamName, setTeamName] = useState("")
  const [proposal, setProposal] = useState<AutoOrchestrationProposal | null>(null)

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
    setTeamName("")
    setProposal(null)
  }

  const handleCompose = async () => {
    const trimmed = objective.trim()
    if (!trimmed) {
      toast.error(t("objectiveRequired"))
      return
    }
    const client = resolveClient()
    if (!client) {
      toast.error(t("noClient"))
      return
    }
    setPhase("loading")
    try {
      const next = await plan({ objective: trimmed, client })
      setProposal(next)
      setTeamName(next.objective.slice(0, 60))
      setPhase("preview")
      log.info("auto_compose_planned", {
        roster: next.roster.length,
        tasks: next.tasks.length,
        pattern: next.assessment.recommendedPattern,
      })
    } catch (err) {
      setPhase("input")
      if (err instanceof AutoOrchestrationPiiError) {
        toast.error(t("piiRefused"))
      } else {
        log.error("auto_compose_failed", err)
        toast.error(t("failed", { error: err instanceof Error ? err.message : String(err) }))
      }
    }
  }

  const handleApprove = () => {
    if (!proposal) return
    const { teamId } = materialize(proposal, { name: teamName.trim() || undefined })
    log.info("auto_compose_materialized", { teamId })
    toast.success(t("created"))
    onComposed(teamId)
    reset()
  }

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

        {phase !== "preview" ? (
          <div className="space-y-2">
            <Label className="text-xs">{t("objectiveLabel")}</Label>
            <Textarea
              rows={4}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder={t("objectivePlaceholder")}
              className="text-sm"
              disabled={phase === "loading"}
              data-testid="auto-compose-objective"
            />
          </div>
        ) : proposal ? (
          <div
            className="space-y-4 max-h-[60vh] overflow-y-auto pr-1"
            data-testid="auto-compose-preview"
          >
            {/* Assessment */}
            <div className="space-y-1 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {proposal.assessment.recommendedPattern}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {t("confidence", {
                    pct: Math.round(proposal.assessment.confidence * 100),
                  })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{proposal.assessment.reason}</p>
            </div>

            {/* Roster */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <UsersIcon className="size-3.5" />
                {t("rosterLabel", { count: proposal.roster.length })}
              </Label>
              <div className="space-y-1">
                {proposal.roster.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded border bg-muted/20 px-2 py-1.5 text-xs"
                  >
                    <span className="font-medium">{m.name}</span>
                    {m.role === "lead" && (
                      <Badge variant="secondary" className="text-[9px]">
                        {t("lead")}
                      </Badge>
                    )}
                    {m.specialization && (
                      <span className="text-[11px] text-muted-foreground">{m.specialization}</span>
                    )}
                    <span className="ml-auto truncate text-[11px] text-muted-foreground">
                      {m.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Tasks */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t("tasksLabel", { count: proposal.tasks.length })}</Label>
              <ol className="space-y-1">
                {proposal.tasks.map((task, i) => (
                  <li key={i} className="rounded border bg-muted/20 px-2 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">#{i}</span>
                      <span className="font-medium">{task.title}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        → {proposal.roster[task.assignedTo]?.name ?? `#${task.assignedTo}`}
                      </span>
                    </div>
                    {task.dependencies.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {t("dependsOn", { deps: task.dependencies.map((d) => `#${d}`).join(", ") })}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </div>

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
              <Button size="sm" onClick={handleApprove} data-testid="auto-compose-approve">
                {t("approve")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleCompose()}
                disabled={phase === "loading"}
                data-testid="auto-compose-submit"
              >
                {phase === "loading" ? (
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
