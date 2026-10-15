"use client"

/**
 * DelegationRulesSection (Thread B) — CRUD editor for the rule-based delegation
 * that routes a chat turn to an external agent. Rules are evaluated
 * priority-first (highest first); the first match whose target is connected
 * wins (see `lib/ai/agent/external/delegation-router.ts` +
 * `ExternalAgentManager.checkDelegation`).
 */

import { useCallback, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { getExternalAgentLifecycleService } from "@/lib/ai/agent/external/lifecycle/service"
import { lifecycleErrorMessage } from "@/lib/ai/agent/external/lifecycle/error-messages"
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { BrandIcon } from "@/components/icons/brand-icon"
import { SettingsStack } from "@/components/settings/common/settings-block"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ResponsiveFormDialog } from "@/components/shared/responsive-form-dialog"
import {
  InstanceTraitChips,
  useInstanceTraitLine,
  type InstanceTrait,
} from "@/components/agent/external-agent/instance-traits"
import {
  distinguishingTraits,
  runtimeSiblings,
} from "@/lib/ai/agent/external/config/instance-family"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Route } from "lucide-react"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import {
  selectDelegationRules,
  selectAgents,
  selectConnectionStatus,
} from "@/stores/agent/external-agent-store"
import type { ExternalAgentDelegationRule } from "@/types/agent/external-agent"

type DelegationCondition = ExternalAgentDelegationRule["condition"]

const CONDITIONS: DelegationCondition[] = [
  "keyword",
  "task-type",
  "capability",
  "tool-needed",
  "always",
  "custom",
]

interface RuleFormData {
  name: string
  condition: DelegationCondition
  matcher: string
  targetAgentId: string
  description: string
}

const EMPTY_FORM: RuleFormData = {
  name: "",
  condition: "keyword",
  matcher: "",
  targetAgentId: "",
  description: "",
}

export function DelegationRulesSection({
  disabled = false,
  createForAgent,
  onAddAgent,
  onOpenAgent,
}: {
  disabled?: boolean
  onAddAgent?: () => void
  onOpenAgent?: (id: string) => void
  /**
   * Fresh object each time the caller wants the create dialog opened with the
   * target pre-selected — the readiness "Add routing rule" action hands the
   * agent over this way so the user lands mid-flow instead of on the list.
   */
  createForAgent?: { agentId: string } | null
}) {
  const t = useTranslations("externalAgent.settings.delegation")
  const tManage = useTranslations("externalAgentManage.delegation")
  const tAgent = useTranslations("externalAgent")
  const tCommon = useTranslations("common")
  const tErrors = useTranslations("externalAgent.lifecycleErrors")
  const [enablingTargetId, setEnablingTargetId] = useState<string | null>(null)
  const traitLine = useInstanceTraitLine()
  const uid = useId()

  const rules = useExternalAgentStore(selectDelegationRules)
  const storedAgents = useExternalAgentStore(selectAgents)
  const connectionStatus = useExternalAgentStore(selectConnectionStatus)
  const agents = useMemo(
    () => Object.values(storedAgents).sort((a, b) => Number(b.enabled) - Number(a.enabled)),
    [storedAgents]
  )
  const { addDelegationRule, updateDelegationRule, removeDelegationRule, reorderDelegationRules } =
    useExternalAgentStore()
  const hasEnabledAgents = agents.some((agent) => agent.enabled)
  const [errors, setErrors] = useState<Partial<Record<"name" | "matcher" | "target", string>>>({})
  const nameRef = useRef<HTMLInputElement>(null)
  const matcherRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLButtonElement>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RuleFormData>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<ExternalAgentDelegationRule | null>(null)

  // Consume the caller's seed during render (the documented alternative to a
  // setState-in-effect). Disabled agents can also be targeted; deleted ones
  // cannot be displayed in the target picker.
  // Starts at null even when mounted with a seed — the seed is consumed on
  // that first render, not swallowed by the initializer.
  const [consumedSeed, setConsumedSeed] = useState<{ agentId: string } | null>(null)
  if (createForAgent && createForAgent !== consumedSeed) {
    setConsumedSeed(createForAgent)
    if (!disabled && agents.some((agent) => agent.id === createForAgent.agentId)) {
      setErrors({})
      setEditingId(null)
      setForm({ ...EMPTY_FORM, targetAgentId: createForAgent.agentId })
      setEditorOpen(true)
    }
  }

  const enableTarget = async (agentId: string) => {
    setEnablingTargetId(agentId)
    try {
      const lifecycle = await getExternalAgentLifecycleService()
      await lifecycle.updateConfig(agentId, { enabled: true })
      toast.success(tAgent("settings.agentUpdated"))
    } catch (error) {
      toast.error(lifecycleErrorMessage(error, tErrors))
    } finally {
      setEnablingTargetId(null)
    }
  }

  const openCreate = useCallback(() => {
    setErrors({})
    setEditingId(null)
    setForm({ ...EMPTY_FORM, targetAgentId: agents[0]?.id ?? "" })
    setEditorOpen(true)
  }, [agents])

  const openEdit = useCallback((rule: ExternalAgentDelegationRule) => {
    setErrors({})
    setEditingId(rule.id)
    setForm({
      name: rule.name,
      condition: rule.condition,
      matcher: rule.matcher,
      targetAgentId: rule.targetAgentId,
      description: rule.description ?? "",
    })
    setEditorOpen(true)
  }, [])

  const handleSave = useCallback(() => {
    const nextErrors: typeof errors = {}
    if (!form.name.trim()) nextErrors.name = tManage("nameRequired")
    if (form.condition !== "always" && !form.matcher.trim()) {
      nextErrors.matcher = tManage("matcherRequired")
    }
    if (!agents.some((agent) => agent.id === form.targetAgentId)) {
      nextErrors.target = tManage("targetRequired")
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      const first = nextErrors.name ? nameRef : nextErrors.matcher ? matcherRef : targetRef
      first.current?.focus()
      return
    }

    if (editingId) {
      updateDelegationRule(editingId, {
        name: form.name.trim(),
        condition: form.condition,
        matcher: form.matcher.trim(),
        targetAgentId: form.targetAgentId,
        description: form.description.trim() || undefined,
      })
    } else {
      addDelegationRule({
        name: form.name.trim(),
        condition: form.condition,
        matcher: form.matcher.trim(),
        targetAgentId: form.targetAgentId,
        priority: rules.length + 1,
        enabled: true,
        description: form.description.trim() || undefined,
      })
    }
    setEditorOpen(false)
  }, [form, editingId, rules.length, addDelegationRule, updateDelegationRule, agents, tManage])

  const move = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction
      if (target < 0 || target >= rules.length) return
      const ids = rules.map((r) => r.id)
      ;[ids[index], ids[target]] = [ids[target], ids[index]]
      reorderDelegationRules(ids)
    },
    [rules, reorderDelegationRules]
  )

  const agentName = useCallback(
    (id: string) => agents.find((a) => a.id === id)?.name ?? tManage("missingTarget"),
    [agents, tManage]
  )

  // What sets each target apart from the other configurations of its runtime
  // (ADR-0216): two Codex configurations otherwise read identically here, and
  // a rule routed to the wrong one runs with the wrong permissions or account.
  const traitsById = useMemo(() => {
    const byId = new Map<string, InstanceTrait[]>()
    for (const agent of agents) {
      byId.set(agent.id, distinguishingTraits(agent, runtimeSiblings(agent, agents)))
    }
    return byId
  }, [agents])

  return (
    <SettingsStack>
      <section data-testid="delegation-rules-section">
        {/* Wraps by its own width: the settings pane is measured by container
            queries, so a viewport breakpoint would be the wrong ruler here. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <h3
              tabIndex={-1}
              data-detail-heading
              className="flex items-center gap-2 text-base font-semibold outline-none"
            >
              <Route className="h-5 w-5 shrink-0" />
              {tAgent("rail.automaticRouting")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
          </div>
          {/* When the empty state below carries the step that comes first
              (add an agent, enable one), adding a rule is the secondary path:
              two filled buttons on one screen left no obvious next move. */}
          <Button
            variant={rules.length === 0 && !hasEnabledAgents ? "outline" : "default"}
            className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
            onClick={openCreate}
            disabled={disabled || agents.length === 0}
            data-testid="delegation-add-rule"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("addRule")}
          </Button>
        </div>
        <div className="mt-5">
          {rules.length === 0 ? (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Route className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>
                  {agents.length === 0
                    ? tManage("noAgentsTitle")
                    : !hasEnabledAgents
                      ? tManage("noEnabledTitle")
                      : t("emptyTitle")}
                </EmptyTitle>
                <EmptyDescription>
                  {agents.length === 0
                    ? t("emptyNoAgents")
                    : !hasEnabledAgents
                      ? tManage("noEnabledDescription")
                      : t("emptyDescription")}
                </EmptyDescription>
              </EmptyHeader>
              {agents.length === 0 && onAddAgent ? (
                <Button
                  className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
                  disabled={disabled}
                  onClick={onAddAgent}
                >
                  {tManage("addAgent")}
                </Button>
              ) : agents.length > 0 && !hasEnabledAgents && onOpenAgent ? (
                <Button
                  className="w-full @md/settings-stack:w-auto [[data-detail-density=stacked]_&]:w-full"
                  disabled={disabled}
                  onClick={() => onOpenAgent(agents[0].id)}
                >
                  {tManage("openAgent", { name: agents[0].name })}
                </Button>
              ) : null}
            </Empty>
          ) : (
            <ol className="divide-y divide-border/60">
              {rules.map((rule, index) => {
                const target = agents.find((agent) => agent.id === rule.targetAgentId)
                const status = connectionStatus[rule.targetAgentId] ?? "disconnected"
                return (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3 py-4"
                    data-testid={`delegation-rule-${rule.id}`}
                  >
                    <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                      <span
                        className="text-xs tabular-nums text-muted-foreground"
                        aria-label={tManage("priority", { priority: index + 1 })}
                      >
                        {index + 1}
                      </span>
                      <div className="flex shrink-0 flex-col">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="touch-hit h-5 w-5"
                          disabled={disabled || index === 0}
                          onClick={() => move(index, -1)}
                          aria-label={t("moveUp")}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="touch-hit h-5 w-5"
                          disabled={disabled || index === rules.length - 1}
                          onClick={() => move(index, 1)}
                          aria-label={t("moveDown")}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 break-words font-medium">{rule.name}</span>
                          <Badge variant="secondary" className="text-xs">
                            {t(`condition.${rule.condition}`)}
                          </Badge>
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            {target ? (
                              <BrandIcon
                                id={
                                  typeof target.metadata?.preset === "string"
                                    ? target.metadata.preset
                                    : target.name
                                }
                                size={16}
                              />
                            ) : null}
                            <span className="min-w-0 break-words">
                              {t("toLabel", { name: agentName(rule.targetAgentId) })}
                            </span>
                          </span>
                          {target ? (
                            <Badge variant="secondary" className="text-xs">
                              {!target.enabled
                                ? tManage("disabledTarget")
                                : tAgent(
                                    `status${status.charAt(0).toUpperCase()}${status.slice(1)}`
                                  )}
                            </Badge>
                          ) : null}
                          {target && !target.enabled ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={disabled || enablingTargetId !== null}
                              aria-busy={enablingTargetId === target.id}
                              onClick={() => void enableTarget(target.id)}
                            >
                              {tManage("enableTarget")}
                            </Button>
                          ) : null}
                          <InstanceTraitChips traits={traitsById.get(rule.targetAgentId) ?? []} />
                        </div>
                        {rule.condition !== "always" && (
                          <code className="break-all rounded bg-muted px-1 text-xs">
                            {rule.matcher}
                          </code>
                        )}
                        {target && !target.enabled ? (
                          <p className="text-xs text-muted-foreground">
                            {tManage("disabledTargetHint")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={rule.enabled}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          updateDelegationRule(rule.id, { enabled: checked })
                        }
                        aria-label={tManage("toggleLabel", { name: rule.name })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="touch-hit"
                        disabled={disabled}
                        onClick={() => openEdit(rule)}
                        aria-label={tManage("editLabel", { name: rule.name })}
                      >
                        {tCommon("edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="touch-hit text-destructive hover:text-destructive"
                        disabled={disabled}
                        onClick={() => setPendingDelete(rule)}
                        aria-label={tManage("deleteLabel", { name: rule.name })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </section>

      <ResponsiveFormDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editingId ? t("editRule") : t("addRule")}
        description={t("formDescription")}
        contentClassName="max-w-[480px]"
        testid="delegation-rule-editor"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleSave}>{editingId ? tCommon("save") : tCommon("add")}</Button>
          </>
        }
      >
        <div className="grid gap-2">
          <Label htmlFor={`${uid}-name`}>{t("ruleName")}</Label>
          <Input
            ref={nameRef}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${uid}-name-error` : undefined}
            id={`${uid}-name`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("ruleNamePlaceholder")}
          />
          {errors.name ? (
            <p id={`${uid}-name-error`} className="text-xs text-destructive">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${uid}-condition`}>{t("conditionLabel")}</Label>
          <Select
            value={form.condition}
            onValueChange={(v) => setForm({ ...form, condition: v as DelegationCondition })}
          >
            <SelectTrigger id={`${uid}-condition`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`condition.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {form.condition !== "always" && (
          <div className="grid gap-2">
            <Label htmlFor={`${uid}-matcher`}>{t("matcherLabel")}</Label>
            <Input
              ref={matcherRef}
              aria-invalid={!!errors.matcher}
              aria-describedby={`${uid}-matcher-hint${errors.matcher ? ` ${uid}-matcher-error` : ""}`}
              id={`${uid}-matcher`}
              value={form.matcher}
              onChange={(e) => setForm({ ...form, matcher: e.target.value })}
              placeholder={t("matcherPlaceholder")}
            />
            <p id={`${uid}-matcher-hint`} className="text-xs text-muted-foreground">
              {t(`matcherHint.${form.condition}`)}
            </p>
            {errors.matcher ? (
              <p id={`${uid}-matcher-error`} className="text-xs text-destructive">
                {errors.matcher}
              </p>
            ) : null}
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor={`${uid}-target`}>{t("targetLabel")}</Label>
          <Select
            value={form.targetAgentId}
            onValueChange={(v) => setForm({ ...form, targetAgentId: v })}
          >
            <SelectTrigger
              ref={targetRef}
              id={`${uid}-target`}
              className="min-w-0"
              aria-invalid={!!errors.target}
              aria-describedby={
                [
                  errors.target ? `${uid}-target-error` : null,
                  agents.some((agent) => agent.id === form.targetAgentId && !agent.enabled)
                    ? `${uid}-target-hint`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              <SelectValue placeholder={t("targetPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                const traits = traitLine(traitsById.get(agent.id) ?? [])
                return (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {agent.enabled
                          ? agent.name
                          : tManage("disabledTargetOption", { name: agent.name })}
                      </span>
                      {traits ? (
                        <span
                          className="truncate text-xs text-muted-foreground"
                          data-testid={`delegation-target-traits-${agent.id}`}
                        >
                          {traits}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {agents.some((agent) => agent.id === form.targetAgentId && !agent.enabled) ? (
            <p id={`${uid}-target-hint`} className="text-xs text-muted-foreground">
              {tManage("disabledTargetHint")}
            </p>
          ) : null}
          {errors.target ? (
            <p id={`${uid}-target-error`} className="text-xs text-destructive">
              {errors.target}
            </p>
          ) : null}
        </div>
      </ResponsiveFormDialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tManage("deleteTitle", { name: pendingDelete?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{tManage("deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) removeDelegationRule(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsStack>
  )
}

export default DelegationRulesSection
