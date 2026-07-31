"use client"

/**
 * DispatchRules — shared, self-managing "inbound dispatch rules" section for
 * every IM adapter's detail panel (W3 multi-bot 条件规则表 v1).
 *
 * Edits `AdapterInstanceRow.dispatchRules`: a declarative, ordered condition
 * table (keywords / regex / sender ids / channel kind → character | team |
 * workflow) evaluated per inbound message by
 * `lib/connectors/dispatch-rules.ts:matchDispatchRule`. Array order = rule
 * priority (first match wins); up/down buttons reorder. Precedence at
 * dispatch: explicit conversation overrides (`/team`, `/character`,
 * `/workflow`) beat rules; rules beat the bot-level defaults.
 *
 * Same pattern as `ControlCommands` / `AiBindingDefaults`: takes only
 * `adapterId`, reads the row via `useLiveQuery`, persists the whole array
 * immediately through `updateAdapterInstance`, and is mounted ONCE in
 * `config-detail.tsx` so all platforms get it without per-form wiring.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { TeamPicker } from "./_shared/team-picker"
import type { AdapterInstanceRow, DispatchRule, DispatchRuleMatch } from "@/lib/db/connector-types"
import type { Character } from "@cognia/agent-config-types"

/** Radix Select forbids `""` item values — sentinels for the "any"/"none" entries. */
const ANY_CHANNEL = "__any__"
const NO_CHARACTER = "__none__"
const SAME_BOT = "__same__"

const CHANNEL_KINDS = ["private", "group", "channel", "thread"] as const
type ChannelKindOption = (typeof CHANNEL_KINDS)[number]

type ActionType = "character" | "team" | "workflow"

/** Parse a comma-separated operator input into a trimmed list (undefined when empty). */
function parseList(value: string): string[] | undefined {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

/** Which action axis the rule currently targets (empty action → character UI). */
function deriveActionType(rule: DispatchRule): ActionType {
  if (rule.action.teamId !== undefined) return "team"
  if (rule.action.workflowId !== undefined) return "workflow"
  return "character"
}

/** True when the regex source fails to compile — surfaced as an inline warning. */
function isInvalidPattern(source: string | undefined): boolean {
  if (!source) return false
  try {
    new RegExp(source)
    return false
  } catch {
    return true
  }
}

interface DispatchRuleRowProps {
  rule: DispatchRule
  index: number
  total: number
  characters: Character[]
  /** Enabled same-platform sibling bots — respond-via targets. */
  siblings: AdapterInstanceRow[]
  onChange: (patch: Partial<DispatchRule>) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}

function DispatchRuleRow({
  rule,
  index,
  total,
  characters,
  siblings,
  onChange,
  onMove,
  onDelete,
}: DispatchRuleRowProps) {
  const t = useTranslations("settings.connections.dispatchRules")
  // Local UI state so the operator can pick an action TYPE before its value —
  // the persisted action stays empty (and the rule inert) until a value lands.
  const [pickedType, setPickedType] = useState<ActionType>(() => deriveActionType(rule))
  const actionType: ActionType =
    rule.action.teamId !== undefined || rule.action.workflowId !== undefined
      ? deriveActionType(rule)
      : pickedType

  const patchMatch = (patch: Partial<DispatchRuleMatch>): void => {
    onChange({ match: { ...rule.match, ...patch } })
  }

  const characterKnown =
    !rule.action.characterId || characters.some((c) => c.id === rule.action.characterId)
  const patternInvalid = isInvalidPattern(rule.match.pattern)

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`dispatch-rule-row-${rule.id}`}>
      <div className="flex items-center gap-2">
        <Switch
          checked={rule.enabled !== false}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label={t("enabledAria")}
          data-testid={`dispatch-rule-enabled-${rule.id}`}
        />
        <Input
          className="h-8 flex-1"
          defaultValue={rule.name ?? ""}
          placeholder={t("namePlaceholder", { index: index + 1 })}
          aria-label={t("nameLabel")}
          onChange={(e) => onChange({ name: e.target.value.trim() || undefined })}
          data-testid={`dispatch-rule-name-${rule.id}`}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={t("moveUpAria")}
          data-testid={`dispatch-rule-up-${rule.id}`}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          aria-label={t("moveDownAria")}
          data-testid={`dispatch-rule-down-${rule.id}`}
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 text-destructive"
          onClick={onDelete}
          aria-label={t("deleteAria")}
          data-testid={`dispatch-rule-delete-${rule.id}`}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-keywords-${rule.id}`}>{t("keywordsLabel")}</Label>
          <Input
            id={`dispatch-rule-keywords-${rule.id}`}
            className="h-8"
            defaultValue={rule.match.keywords?.join(", ") ?? ""}
            placeholder={t("keywordsPlaceholder")}
            onChange={(e) => patchMatch({ keywords: parseList(e.target.value) })}
            data-testid={`dispatch-rule-keywords-${rule.id}`}
          />
          <p className="text-xs text-muted-foreground">{t("keywordsHelp")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-pattern-${rule.id}`}>{t("patternLabel")}</Label>
          <Input
            id={`dispatch-rule-pattern-${rule.id}`}
            className="h-8 font-mono"
            defaultValue={rule.match.pattern ?? ""}
            placeholder={t("patternPlaceholder")}
            onChange={(e) => patchMatch({ pattern: e.target.value.trim() || undefined })}
            data-testid={`dispatch-rule-pattern-${rule.id}`}
          />
          {patternInvalid && (
            <p
              className="text-xs text-destructive"
              data-testid={`dispatch-rule-pattern-invalid-${rule.id}`}
            >
              {t("patternInvalid")}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-senders-${rule.id}`}>{t("senderIdsLabel")}</Label>
          <Input
            id={`dispatch-rule-senders-${rule.id}`}
            className="h-8 font-mono"
            defaultValue={rule.match.senderIds?.join(", ") ?? ""}
            placeholder={t("senderIdsPlaceholder")}
            onChange={(e) => patchMatch({ senderIds: parseList(e.target.value) })}
            data-testid={`dispatch-rule-senders-${rule.id}`}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-channel-${rule.id}`}>{t("channelLabel")}</Label>
          <Select
            value={rule.match.channelKinds?.[0] ?? ANY_CHANNEL}
            onValueChange={(v) =>
              patchMatch({
                channelKinds: v === ANY_CHANNEL ? undefined : [v as ChannelKindOption],
              })
            }
          >
            <SelectTrigger
              id={`dispatch-rule-channel-${rule.id}`}
              className="h-8"
              data-testid={`dispatch-rule-channel-${rule.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_CHANNEL}>{t("channelAny")}</SelectItem>
              {CHANNEL_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`channel_${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-action-${rule.id}`}>{t("actionLabel")}</Label>
          <Select
            value={actionType}
            onValueChange={(v) => {
              setPickedType(v as ActionType)
              // Switching axis clears the previous target — the rule stays
              // inert (skipped by the matcher) until a new value is picked.
              // The respond-via bot is an orthogonal axis and survives.
              onChange({ action: { respondViaAdapterId: rule.action.respondViaAdapterId } })
            }}
          >
            <SelectTrigger
              id={`dispatch-rule-action-${rule.id}`}
              className="h-8"
              data-testid={`dispatch-rule-action-${rule.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="character">{t("actionCharacter")}</SelectItem>
              <SelectItem value="team">{t("actionTeam")}</SelectItem>
              <SelectItem value="workflow">{t("actionWorkflow")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-target-${rule.id}`}>{t("targetLabel")}</Label>
          {actionType === "character" && (
            <Select
              value={
                characterKnown ? (rule.action.characterId ?? NO_CHARACTER) : rule.action.characterId
              }
              onValueChange={(v) =>
                onChange({
                  action: {
                    characterId: v === NO_CHARACTER ? undefined : v,
                    respondViaAdapterId: rule.action.respondViaAdapterId,
                  },
                })
              }
            >
              <SelectTrigger
                id={`dispatch-rule-target-${rule.id}`}
                className="h-8"
                data-testid={`dispatch-rule-character-${rule.id}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CHARACTER}>{t("characterNone")}</SelectItem>
                {!characterKnown && rule.action.characterId && (
                  <SelectItem
                    value={rule.action.characterId}
                    className="text-destructive"
                    data-testid={`dispatch-rule-character-missing-${rule.id}`}
                  >
                    {t("characterMissing", { id: rule.action.characterId.slice(0, 12) })}
                  </SelectItem>
                )}
                {characters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {actionType === "team" && (
            <TeamPicker
              id={`dispatch-rule-target-${rule.id}`}
              value={rule.action.teamId || undefined}
              onChange={(teamId) =>
                onChange({
                  action: { teamId, respondViaAdapterId: rule.action.respondViaAdapterId },
                })
              }
            />
          )}
          {actionType === "workflow" && (
            <Input
              id={`dispatch-rule-target-${rule.id}`}
              className="h-8 font-mono"
              defaultValue={rule.action.workflowId ?? ""}
              placeholder={t("workflowPlaceholder")}
              onChange={(e) =>
                onChange({
                  action: {
                    workflowId: e.target.value.trim() || undefined,
                    respondViaAdapterId: rule.action.respondViaAdapterId,
                  },
                })
              }
              data-testid={`dispatch-rule-workflow-${rule.id}`}
            />
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dispatch-rule-respond-via-${rule.id}`}>{t("respondViaLabel")}</Label>
          <Select
            value={rule.action.respondViaAdapterId ?? SAME_BOT}
            onValueChange={(v) =>
              onChange({
                action: { ...rule.action, respondViaAdapterId: v === SAME_BOT ? undefined : v },
              })
            }
          >
            <SelectTrigger
              id={`dispatch-rule-respond-via-${rule.id}`}
              className="h-8"
              data-testid={`dispatch-rule-respond-via-${rule.id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SAME_BOT}>{t("respondViaSameBot")}</SelectItem>
              {rule.action.respondViaAdapterId &&
                !siblings.some((s) => s.id === rule.action.respondViaAdapterId) && (
                  <SelectItem
                    value={rule.action.respondViaAdapterId}
                    className="text-destructive"
                    data-testid={`dispatch-rule-respond-via-missing-${rule.id}`}
                  >
                    {t("respondViaMissing", { id: rule.action.respondViaAdapterId.slice(0, 12) })}
                  </SelectItem>
                )}
              {siblings.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("respondViaHelp")}</p>
        </div>
      </div>
    </div>
  )
}

export interface DispatchRulesProps {
  adapterId: string
}

export function DispatchRules({ adapterId }: DispatchRulesProps) {
  const t = useTranslations("settings.connections.dispatchRules")

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const characters = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : getDb().characters.toArray()),
    []
  )
  // Respond-via targets: enabled sibling bots of the SAME platform (the
  // runtime rejects cross-platform targets, so don't offer them).
  const siblings = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" || !row?.type
        ? Promise.resolve([])
        : getDb().adapterInstances.where("type").equals(row.type).toArray(),
    [row?.type]
  )
  const respondViaTargets = (siblings ?? []).filter((s) => s.id !== adapterId && s.enabled)

  const rules = row?.dispatchRules ?? []

  const persist = (next: DispatchRule[]): void => {
    void updateAdapterInstance(adapterId, { dispatchRules: next })
  }

  const addRule = (): void => {
    persist([...rules, { id: crypto.randomUUID(), enabled: true, match: {}, action: {} }])
  }

  const changeRule = (index: number, patch: Partial<DispatchRule>): void => {
    persist(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const moveRule = (index: number, direction: -1 | 1): void => {
    const target = index + direction
    if (target < 0 || target >= rules.length) return
    const next = [...rules]
    ;[next[index], next[target]] = [next[target], next[index]]
    persist(next)
  }

  const deleteRule = (index: number): void => {
    persist(rules.filter((_, i) => i !== index))
  }

  return (
    <Card data-testid="dispatch-rules">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        {rules.length === 0 && <p className="text-xs text-muted-foreground">{t("empty")}</p>}

        {rules.map((rule, index) => (
          <DispatchRuleRow
            key={rule.id}
            rule={rule}
            index={index}
            total={rules.length}
            characters={characters ?? []}
            siblings={respondViaTargets}
            onChange={(patch) => changeRule(index, patch)}
            onMove={(direction) => moveRule(index, direction)}
            onDelete={() => deleteRule(index)}
          />
        ))}

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addRule}
          data-testid="dispatch-rule-add"
        >
          <PlusIcon className="mr-1.5 size-3.5" />
          {t("addRule")}
        </Button>
      </CardContent>
    </Card>
  )
}
