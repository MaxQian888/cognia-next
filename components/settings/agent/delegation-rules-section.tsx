"use client"

/**
 * DelegationRulesSection (Thread B) — CRUD editor for the rule-based delegation
 * that routes a chat turn to an external agent. Rules are evaluated
 * priority-first (highest first); the first match whose target is connected
 * wins (see `lib/ai/agent/external/delegation-router.ts` +
 * `ExternalAgentManager.checkDelegation`).
 */

import { useCallback, useId, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { selectDelegationRules, selectEnabledAgents } from "@/stores/agent/external-agent-store"
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
}: {
  disabled?: boolean
  /**
   * Fresh object each time the caller wants the create dialog opened with the
   * target pre-selected — the readiness "Add routing rule" action hands the
   * agent over this way so the user lands mid-flow instead of on the list.
   */
  createForAgent?: { agentId: string } | null
}) {
  const t = useTranslations("externalAgent.settings.delegation")
  const tManage = useTranslations("externalAgentManage.delegation")
  const tCommon = useTranslations("common")
  const traitLine = useInstanceTraitLine()
  const uid = useId()

  const rules = useExternalAgentStore(selectDelegationRules)
  // selectEnabledAgents materialises a fresh array (Object.values().filter().map())
  // each call; useShallow bails out of the re-render unless the contents change,
  // avoiding the getSnapshot infinite loop.
  const agents = useExternalAgentStore(useShallow(selectEnabledAgents))
  const { addDelegationRule, updateDelegationRule, removeDelegationRule, reorderDelegationRules } =
    useExternalAgentStore()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RuleFormData>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<ExternalAgentDelegationRule | null>(null)

  // Consume the caller's seed during render (the documented alternative to a
  // setState-in-effect). Only enabled agents can be targeted — a seed pointing
  // at anything else is dropped rather than producing a rule the target
  // dropdown cannot display.
  // Starts at null even when mounted with a seed — the seed is consumed on
  // that first render, not swallowed by the initializer.
  const [consumedSeed, setConsumedSeed] = useState<{ agentId: string } | null>(null)
  if (createForAgent && createForAgent !== consumedSeed) {
    setConsumedSeed(createForAgent)
    if (!disabled && agents.some((agent) => agent.id === createForAgent.agentId)) {
      setEditingId(null)
      setForm({ ...EMPTY_FORM, targetAgentId: createForAgent.agentId })
      setEditorOpen(true)
    }
  }

  const openCreate = useCallback(() => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, targetAgentId: agents[0]?.id ?? "" })
    setEditorOpen(true)
  }, [agents])

  const openEdit = useCallback((rule: ExternalAgentDelegationRule) => {
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
    if (!form.name.trim() || !form.targetAgentId) return
    // "always" needs no matcher; every other condition does.
    if (form.condition !== "always" && !form.matcher.trim()) return

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
  }, [form, editingId, rules.length, addDelegationRule, updateDelegationRule])

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
    <Card data-testid="delegation-rules-card">
      <CardHeader>
        {/* Wraps by its own width: the settings pane is measured by container
            queries, so a viewport breakpoint would be the wrong ruler here. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <CardTitle className="flex items-center gap-2">
              <Route className="h-5 w-5 shrink-0" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button
            className="shrink-0"
            onClick={openCreate}
            disabled={disabled || agents.length === 0}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("addRule")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Route className="h-6 w-6" />
              </EmptyMedia>
              <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {agents.length === 0 ? t("emptyNoAgents") : t("emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-2">
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border p-3"
                data-testid={`delegation-rule-${rule.id}`}
              >
                <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
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
                      <Badge variant="outline" className="max-w-full truncate text-xs">
                        {t("toLabel", { name: agentName(rule.targetAgentId) })}
                      </Badge>
                      <InstanceTraitChips traits={traitsById.get(rule.targetAgentId) ?? []} />
                    </div>
                    {rule.condition !== "always" && (
                      <code className="break-all rounded bg-muted px-1 text-xs">
                        {rule.matcher}
                      </code>
                    )}
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
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ResponsiveFormDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editingId ? t("editRule") : t("addRule")}
        description={t("formDescription")}
        contentClassName="sm:max-w-[480px]"
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
            id={`${uid}-name`}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("ruleNamePlaceholder")}
          />
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
              id={`${uid}-matcher`}
              value={form.matcher}
              onChange={(e) => setForm({ ...form, matcher: e.target.value })}
              placeholder={t("matcherPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t(`matcherHint.${form.condition}`)}</p>
          </div>
        )}
        <div className="grid gap-2">
          <Label htmlFor={`${uid}-target`}>{t("targetLabel")}</Label>
          <Select
            value={form.targetAgentId}
            onValueChange={(v) => setForm({ ...form, targetAgentId: v })}
          >
            <SelectTrigger id={`${uid}-target`} className="min-w-0">
              <SelectValue placeholder={t("targetPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => {
                const traits = traitLine(traitsById.get(agent.id) ?? [])
                return (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{agent.name}</span>
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
    </Card>
  )
}

export default DelegationRulesSection
