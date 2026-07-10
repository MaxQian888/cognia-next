"use client"

/**
 * AiBindingDefaults — shared, self-managing "which agent answers on this bot"
 * section for every IM adapter's detail panel (W1 multi-bot).
 *
 * Edits the instance-level binding defaults on `AdapterInstanceRow`:
 *   - `defaultCharacterId` (persona; resolved by `resolveBinding` layer 1 —
 *     this closes the "field existed but was never editable" gap)
 *   - `defaultTeamId` (Agent Team; `resolveEffectiveTeamBinding`)
 *   - `defaultProvider` + `defaultModel` (picked together, mirroring
 *     `/model provider/model` semantics; chains in `build-options.ts`)
 *   - `defaultReasoning` (effort chain)
 *
 * Same pattern as `ControlCommands`: takes only `adapterId`, reads the row
 * via `useLiveQuery`, persists immediately through `updateAdapterInstance`,
 * and is mounted ONCE in `config-detail.tsx` so all platforms get it without
 * per-form wiring. Per-conversation overrides (`/model`, `/team`, inbox
 * switchers) always beat these defaults.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { collectOptions } from "@/components/inbox/provider-model-switcher"
import { TeamPicker } from "./_shared/team-picker"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AppSettings, Character } from "@/lib/claude/types"

/** Radix Select forbids `""` item values — sentinel for "use the default". */
const DEFAULT_VALUE = "__default__"

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export interface AiBindingDefaultsProps {
  adapterId: string
}

export function AiBindingDefaults({ adapterId }: AiBindingDefaultsProps) {
  const t = useTranslations("settings.connections.aiBindingDefaults")

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
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

  const options = collectOptions(settings)
  const modelValue =
    row?.defaultProvider || row?.defaultModel
      ? `${row?.defaultProvider ?? ""}:${row?.defaultModel ?? ""}`
      : DEFAULT_VALUE
  // A saved default that is no longer among the configured options must stay
  // visible (and clearable) instead of silently blanking the select.
  const modelValueKnown = options.some((o) => `${o.providerId}:${o.modelId}` === modelValue)
  const characterKnown =
    !row?.defaultCharacterId || (characters ?? []).some((c) => c.id === row.defaultCharacterId)

  const persist = (patch: Partial<AdapterInstanceRow>): void => {
    void updateAdapterInstance(adapterId, patch)
  }

  return (
    <Card data-testid="ai-binding-defaults">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("precedenceNote")}</p>

        <div className="space-y-1">
          <Label htmlFor="ai-binding-character">{t("characterLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("characterHelp")}</p>
          <Select
            value={
              characterKnown ? (row?.defaultCharacterId ?? DEFAULT_VALUE) : row?.defaultCharacterId
            }
            onValueChange={(v) =>
              persist({ defaultCharacterId: v === DEFAULT_VALUE ? undefined : v })
            }
          >
            <SelectTrigger id="ai-binding-character" data-testid="ai-binding-character">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VALUE}>{t("characterDefault")}</SelectItem>
              {!characterKnown && row?.defaultCharacterId && (
                <SelectItem
                  value={row.defaultCharacterId}
                  className="text-destructive"
                  data-testid="ai-binding-character-missing"
                >
                  {t("notConfigured", { id: row.defaultCharacterId.slice(0, 12) })}
                </SelectItem>
              )}
              {(characters ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id} data-testid={`ai-binding-character-${c.id}`}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-binding-team">{t("teamLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("teamHelp")}</p>
          <TeamPicker
            id="ai-binding-team"
            value={row?.defaultTeamId || undefined}
            onChange={(teamId) => persist({ defaultTeamId: teamId })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-binding-model">{t("modelLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("modelHelp")}</p>
          <Select
            value={modelValue}
            onValueChange={(v) => {
              if (v === DEFAULT_VALUE) {
                persist({ defaultProvider: undefined, defaultModel: undefined })
                return
              }
              const sep = v.indexOf(":")
              persist({
                defaultProvider: v.slice(0, sep) || undefined,
                defaultModel: v.slice(sep + 1) || undefined,
              })
            }}
          >
            <SelectTrigger id="ai-binding-model" data-testid="ai-binding-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[50vh]">
              <SelectItem value={DEFAULT_VALUE}>{t("modelDefault")}</SelectItem>
              {!modelValueKnown && modelValue !== DEFAULT_VALUE && (
                <SelectItem
                  value={modelValue}
                  className="text-destructive"
                  data-testid="ai-binding-model-missing"
                >
                  {t("notConfigured", {
                    id: `${row?.defaultProvider ?? "?"} · ${row?.defaultModel ?? "?"}`,
                  })}
                </SelectItem>
              )}
              {options.map((opt) => (
                <SelectItem
                  key={`${opt.providerId}:${opt.modelId}`}
                  value={`${opt.providerId}:${opt.modelId}`}
                  data-testid={`ai-binding-model-${opt.providerId}-${opt.modelId}`}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="ai-binding-reasoning">{t("reasoningLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("reasoningHelp")}</p>
          <Select
            value={row?.defaultReasoning ?? DEFAULT_VALUE}
            onValueChange={(v) =>
              persist({
                defaultReasoning: v === DEFAULT_VALUE ? undefined : (v as ReasoningLevel),
              })
            }
          >
            <SelectTrigger id="ai-binding-reasoning" data-testid="ai-binding-reasoning">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_VALUE}>{t("reasoningDefault")}</SelectItem>
              {REASONING_LEVELS.map((level) => (
                <SelectItem key={level} value={level} data-testid={`ai-binding-reasoning-${level}`}>
                  {t(`reasoning_${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}
