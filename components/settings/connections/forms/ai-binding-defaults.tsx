"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { collectOptions } from "@/components/inbox/provider-model-switcher"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import type { AppSettings, Character } from "@cognia/agent-config-types"
import { EntityPicker } from "./_shared/entity-picker"
import { TeamPicker } from "./_shared/team-picker"

const DEFAULT_VALUE = "__default__"
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningLevel = (typeof REASONING_LEVELS)[number]
type TargetKind = "direct" | "team" | "workflow"

interface Draft {
  target: TargetKind
  characterId?: string
  teamId?: string
  workflowId?: string
  provider?: string
  model?: string
  reasoning?: ReasoningLevel
}

function fromRow(row?: AdapterInstanceRow): Draft {
  const target: TargetKind = row?.defaultTeamId
    ? "team"
    : row?.defaultWorkflowId
      ? "workflow"
      : "direct"
  return {
    target,
    characterId: row?.defaultCharacterId,
    teamId: row?.defaultTeamId,
    workflowId: row?.defaultWorkflowId,
    provider: row?.defaultProvider,
    model: row?.defaultModel,
    reasoning: row?.defaultReasoning,
  }
}

export function AiBindingDefaults({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  return (
    <AiBindingDefaultsDraft
      key={`${adapterId}:${row?.updatedAt ?? "loading"}`}
      adapterId={adapterId}
      row={row}
    />
  )
}

function AiBindingDefaultsDraft({
  adapterId,
  row,
}: {
  adapterId: string
  row?: AdapterInstanceRow
}) {
  const t = useTranslations("settings.connections.aiBindingDefaults")
  const settings = useLiveQuery<AppSettings | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().settings.get("singleton"),
    []
  )
  const characters = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : getDb().characters.toArray()),
    []
  )
  const executableWorkflows = useLiveQuery(async () => {
    if (typeof window === "undefined") return []
    const [workflows, deployments] = await Promise.all([
      getDb().workflows.toArray(),
      getDb().workflowDeployments.toArray(),
    ])
    const active = new Set(
      deployments
        .filter((item) => item.environment === "production" && item.status === "active")
        .map((item) => item.workflowId)
    )
    return workflows.filter((workflow) => active.has(workflow.id))
  }, [])
  const [draft, setDraft] = useState<Draft>(() => fromRow(row))

  const modelOptions = collectOptions(settings)
  const modelValue =
    draft.provider || draft.model ? `${draft.provider ?? ""}:${draft.model ?? ""}` : DEFAULT_VALUE
  const modelKnown = modelOptions.some(
    (option) => `${option.providerId}:${option.modelId}` === modelValue
  )
  const workflowItems = useMemo(
    () =>
      (executableWorkflows ?? []).map((workflow) => ({
        id: workflow.id,
        label: workflow.name,
        description: t("workflowProduction"),
      })),
    [executableWorkflows, t]
  )

  const save = async () => {
    await updateAdapterConfigSection(
      adapterId,
      "responder",
      {
        defaultCharacterId: draft.characterId,
        defaultTeamId: draft.target === "team" ? draft.teamId : undefined,
        defaultWorkflowId: draft.target === "workflow" ? draft.workflowId : undefined,
        defaultProvider: draft.target === "direct" ? draft.provider : undefined,
        defaultModel: draft.target === "direct" ? draft.model : undefined,
        defaultReasoning: draft.target === "direct" ? draft.reasoning : undefined,
      },
      "settings.adapter.responder"
    )
  }

  return (
    <Card data-testid="ai-binding-defaults">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("precedenceNote")}</p>

        <div className="space-y-1">
          <Label htmlFor="ai-binding-target">{t("targetLabel")}</Label>
          <Select
            value={draft.target}
            onValueChange={(target) =>
              setDraft((current) => ({ ...current, target: target as TargetKind }))
            }
          >
            <SelectTrigger id="ai-binding-target" data-testid="ai-binding-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">{t("targetDirect")}</SelectItem>
              <SelectItem value="team">{t("targetTeam")}</SelectItem>
              <SelectItem value="workflow">{t("targetWorkflow")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {draft.target === "team" && (
          <div className="space-y-1">
            <Label htmlFor="ai-binding-team">{t("teamLabel")}</Label>
            <TeamPicker
              id="ai-binding-team"
              value={draft.teamId}
              onChange={(teamId) => setDraft((current) => ({ ...current, teamId }))}
            />
          </div>
        )}

        {draft.target === "workflow" && (
          <div className="space-y-1">
            <Label htmlFor="ai-binding-workflow">{t("workflowLabel")}</Label>
            <EntityPicker
              id="ai-binding-workflow"
              value={draft.workflowId}
              items={workflowItems}
              emptyLabel={t("workflowNone")}
              missingLabel={(id) => t("notConfigured", { id: id.slice(0, 12) })}
              onChange={(workflowId) => setDraft((current) => ({ ...current, workflowId }))}
            />
            <p className="text-xs text-muted-foreground">{t("workflowHelp")}</p>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="ai-binding-character">{t("characterLabel")}</Label>
          <EntityPicker
            id="ai-binding-character"
            value={draft.characterId}
            items={(characters ?? []).map((character) => ({
              id: character.id,
              label: character.name,
            }))}
            emptyLabel={t("characterDefault")}
            missingLabel={(id) => t("notConfigured", { id: id.slice(0, 12) })}
            onChange={(characterId) => setDraft((current) => ({ ...current, characterId }))}
          />
          <p className="text-xs text-muted-foreground">
            {draft.target === "team"
              ? t("characterTeamHelp")
              : draft.target === "workflow"
                ? t("characterWorkflowHelp")
                : t("characterHelp")}
          </p>
        </div>

        {draft.target === "direct" ? (
          <>
            <div className="space-y-1">
              <Label htmlFor="ai-binding-model">{t("modelLabel")}</Label>
              <Select
                value={modelValue}
                onValueChange={(next) => {
                  if (next === DEFAULT_VALUE) {
                    setDraft((current) => ({ ...current, provider: undefined, model: undefined }))
                    return
                  }
                  const separator = next.indexOf(":")
                  setDraft((current) => ({
                    ...current,
                    provider: next.slice(0, separator) || undefined,
                    model: next.slice(separator + 1) || undefined,
                  }))
                }}
              >
                <SelectTrigger id="ai-binding-model" data-testid="ai-binding-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[50vh]">
                  <SelectItem value={DEFAULT_VALUE}>{t("modelDefault")}</SelectItem>
                  {!modelKnown && modelValue !== DEFAULT_VALUE && (
                    <SelectItem
                      value={modelValue}
                      className="text-destructive"
                      data-testid="ai-binding-model-missing"
                    >
                      {t("notConfigured", {
                        id: `${draft.provider ?? "?"} · ${draft.model ?? "?"}`,
                      })}
                    </SelectItem>
                  )}
                  {modelOptions.map((option) => (
                    <SelectItem
                      key={`${option.providerId}:${option.modelId}`}
                      value={`${option.providerId}:${option.modelId}`}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-binding-reasoning">{t("reasoningLabel")}</Label>
              <Select
                value={draft.reasoning ?? DEFAULT_VALUE}
                onValueChange={(next) =>
                  setDraft((current) => ({
                    ...current,
                    reasoning: next === DEFAULT_VALUE ? undefined : (next as ReasoningLevel),
                  }))
                }
              >
                <SelectTrigger id="ai-binding-reasoning" data-testid="ai-binding-reasoning">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>{t("reasoningDefault")}</SelectItem>
                  {REASONING_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(`reasoning_${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        ) : (
          <p
            className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground"
            data-testid="ai-binding-target-managed"
          >
            {t("modelManagedByTarget")}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(fromRow(row))}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("save")}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
