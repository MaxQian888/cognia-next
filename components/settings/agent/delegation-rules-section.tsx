"use client"

/**
 * DelegationRulesSection (Thread B) — CRUD editor for the rule-based delegation
 * that routes a chat turn to an external agent. Rules are evaluated
 * priority-first (highest first); the first match whose target is connected
 * wins (see `lib/ai/agent/external/delegation-router.ts` +
 * `ExternalAgentManager.checkDelegation`).
 */

import { useCallback, useState } from "react"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

export function DelegationRulesSection({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("externalAgent.settings.delegation")
  const tCommon = useTranslations("common")

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
    (id: string) => agents.find((a) => a.id === id)?.name ?? id,
    [agents]
  )

  return (
    <Card data-testid="delegation-rules-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Route className="h-5 w-5" />
              {t("title")}
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button onClick={openCreate} disabled={disabled || agents.length === 0}>
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
                className="flex items-center justify-between rounded-lg border p-3"
                data-testid={`delegation-rule-${rule.id}`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex flex-col">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={t("moveUp")}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      disabled={disabled || index === rules.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={t("moveDown")}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{rule.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {t(`condition.${rule.condition}`)}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {t("toLabel", { name: agentName(rule.targetAgentId) })}
                      </Badge>
                    </div>
                    {rule.condition !== "always" && (
                      <code className="rounded bg-muted px-1 text-xs">{rule.matcher}</code>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={rule.enabled}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updateDelegationRule(rule.id, { enabled: checked })
                    }
                    aria-label={t("toggleEnabled")}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => openEdit(rule)}
                  >
                    {tCommon("edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    disabled={disabled}
                    onClick={() => removeDelegationRule(rule.id)}
                    aria-label={tCommon("delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editingId ? t("editRule") : t("addRule")}</DialogTitle>
            <DialogDescription>{t("formDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="rule-name">{t("ruleName")}</Label>
              <Input
                id="rule-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("ruleNamePlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("conditionLabel")}</Label>
              <Select
                value={form.condition}
                onValueChange={(v) => setForm({ ...form, condition: v as DelegationCondition })}
              >
                <SelectTrigger>
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
                <Label htmlFor="rule-matcher">{t("matcherLabel")}</Label>
                <Input
                  id="rule-matcher"
                  value={form.matcher}
                  onChange={(e) => setForm({ ...form, matcher: e.target.value })}
                  placeholder={t("matcherPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">
                  {t(`matcherHint.${form.condition}`)}
                </p>
              </div>
            )}
            <div className="grid gap-2">
              <Label>{t("targetLabel")}</Label>
              <Select
                value={form.targetAgentId}
                onValueChange={(v) => setForm({ ...form, targetAgentId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("targetPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleSave}>{editingId ? tCommon("save") : tCommon("add")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default DelegationRulesSection
