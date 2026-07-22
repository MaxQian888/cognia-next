"use client"

/** Lark admission, durable active-run dispatch, and no-@ readiness controls. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { DEFAULT_BOT_INTERPLAY_BUDGET } from "@/lib/connectors/adapters/lark/at-gate"
import { resolveInboundActivationPolicy } from "@/lib/connectors/conversation-admission"
import type { ActiveRunDispatchMode, InboundActivationPolicy } from "@/types/connectors/policy"
import { builtInConnectorRuntimeCapabilities } from "@/types/connectors/runtime-capability"

const STRATEGIES: InboundActivationPolicy[] = [
  "mention_activates",
  "mention_each",
  "always",
  "direct_only",
]
const DISPATCH_MODES: ActiveRunDispatchMode[] = ["queue", "steer"]

type SiblingBotPolicy = NonNullable<AdapterInstanceRow["siblingBotPolicy"]>

const SIBLING_POLICIES: SiblingBotPolicy[] = ["ignore", "respond"]

export interface LarkAtStrategyProps {
  adapterId: string
}

export function LarkAtStrategy({ adapterId }: LarkAtStrategyProps) {
  const t = useTranslations("settings.connections.lark.atStrategy")
  const [saving, setSaving] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const current = row ? resolveInboundActivationPolicy(row) : "mention_activates"
  const dispatchMode = row?.activeRunDispatchMode ?? "queue"
  const readiness = row?.deliveryReadiness ?? "unknown"
  const effectivePolicy =
    (current === "always" || current === "mention_activates") &&
    readiness !== "all_messages_verified"
      ? "mention_each"
      : current
  const runtimeCapabilities = builtInConnectorRuntimeCapabilities("lark")
  const siblingPolicy: SiblingBotPolicy = row?.siblingBotPolicy ?? "ignore"

  const onChange = async (value: string) => {
    if (!STRATEGIES.includes(value as InboundActivationPolicy)) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, {
        inboundActivationPolicy: value as InboundActivationPolicy,
        deliveryReadiness: row?.deliveryReadiness ?? "mentions_only",
      })
    } finally {
      setSaving(false)
    }
  }

  const onDispatchModeChange = async (value: string) => {
    if (!DISPATCH_MODES.includes(value as ActiveRunDispatchMode)) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, {
        activeRunDispatchMode: value as ActiveRunDispatchMode,
      })
    } finally {
      setSaving(false)
    }
  }

  const onActivationTtlChange = async (raw: string) => {
    const hours = Number(raw)
    if (!Number.isFinite(hours) || hours <= 0) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { activationTtlMs: Math.round(hours * 3_600_000) })
    } finally {
      setSaving(false)
    }
  }

  const startReadinessProbe = async () => {
    setSaving(true)
    const startedAt = Date.now()
    try {
      await updateAdapterInstance(adapterId, {
        deliveryReadiness: "mentions_only",
        settings: {
          ...(row?.settings ?? {}),
          unmentionedDeliveryProbe: {
            consoleConfirmed: true,
            startedAt,
            expiresAt: startedAt + 10 * 60_000,
          },
        },
      })
    } finally {
      setSaving(false)
    }
  }

  const onSiblingPolicyChange = async (value: string) => {
    if (!SIBLING_POLICIES.includes(value as SiblingBotPolicy)) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, {
        siblingBotPolicy: value as SiblingBotPolicy,
      })
    } finally {
      setSaving(false)
    }
  }

  const onBudgetChange = async (raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isInteger(parsed) || parsed < 1) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { botInterplayBudget: parsed })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="lark-at-strategy">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("help")}</p>
        <RadioGroup value={current} onValueChange={(v) => void onChange(v)} disabled={saving}>
          {STRATEGIES.map((value) => {
            const key =
              value === "mention_each"
                ? "mentionEach"
                : value === "mention_activates"
                  ? "mentionActivates"
                  : value === "direct_only"
                    ? "directOnly"
                    : value
            return (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={value}
                  id={`lark-activation-${value}`}
                  data-testid={`lark-activation-${value}`}
                />
                <div className="flex-1 space-y-0.5">
                  <Label htmlFor={`lark-activation-${value}`} className="cursor-pointer">
                    {t(`options.${key}`)}
                  </Label>
                </div>
              </div>
            )
          })}
        </RadioGroup>
        {!row?.inboundActivationPolicy && !row?.atResponseStrategy && (
          <p className="text-xs text-muted-foreground italic">{t("defaultNotice")}</p>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t("dispatch.title")}</p>
          <p className="text-xs text-muted-foreground">{t("dispatch.help")}</p>
          <RadioGroup
            value={dispatchMode}
            onValueChange={(v) => void onDispatchModeChange(v)}
            disabled={saving}
          >
            {DISPATCH_MODES.map((value) => (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={value}
                  id={`lark-dispatch-${value}`}
                  data-testid={`lark-dispatch-${value}`}
                />
                <Label htmlFor={`lark-dispatch-${value}`} className="cursor-pointer">
                  {t(`dispatch.options.${value}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="space-y-1 pt-1">
            <Label htmlFor="lark-activation-ttl">{t("activationTtl.label")}</Label>
            <Input
              key={row?.activationTtlMs ?? "default"}
              id="lark-activation-ttl"
              type="number"
              min="1"
              step="1"
              defaultValue={(row?.activationTtlMs ?? 24 * 3_600_000) / 3_600_000}
              onBlur={(event) => void onActivationTtlChange(event.target.value)}
              data-testid="lark-activation-ttl"
            />
            <p className="text-xs text-muted-foreground">{t("activationTtl.help")}</p>
          </div>
        </div>

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t("readiness.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t(`readiness.states.${row?.deliveryReadiness ?? "unknown"}`)}
          </p>
          <p className="text-xs text-muted-foreground">{t("readiness.help")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void startReadinessProbe()}
            data-testid="lark-readiness-probe"
          >
            {t("readiness.startProbe")}
          </Button>
        </div>

        <div className="space-y-1 border-t pt-3" data-testid="lark-runtime-diagnostics">
          <p className="text-sm font-medium">{t("diagnostics.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("diagnostics.requested", { value: current })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("diagnostics.effective", { value: effectivePolicy })}
          </p>
          {effectivePolicy !== current && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("diagnostics.unverifiedFallback")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("diagnostics.capabilities", {
              topic: runtimeCapabilities.topicIsolation,
              stream: runtimeCapabilities.textStreaming
                ? t("diagnostics.yes")
                : t("diagnostics.no"),
              mutate: runtimeCapabilities.componentMutation
                ? t("diagnostics.yes")
                : t("diagnostics.no"),
            })}
          </p>
        </div>

        {/* ── Sibling-bot policy (W5 multi-bot same-group) ── */}
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t("sibling.title")}</p>
          <p className="text-xs text-muted-foreground">{t("sibling.help")}</p>
          <RadioGroup
            value={siblingPolicy}
            onValueChange={(v) => void onSiblingPolicyChange(v)}
            disabled={saving}
          >
            {SIBLING_POLICIES.map((value) => (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={value}
                  id={`sibling-policy-${value}`}
                  data-testid={`sibling-policy-${value}`}
                />
                <div className="flex-1 space-y-0.5">
                  <Label htmlFor={`sibling-policy-${value}`} className="cursor-pointer">
                    {t(`sibling.options.${value}`)}
                  </Label>
                </div>
              </div>
            ))}
          </RadioGroup>
          {siblingPolicy === "respond" && (
            <div className="space-y-1">
              <Label htmlFor="sibling-budget" className="text-xs">
                {t("sibling.budgetLabel")}
              </Label>
              <Input
                id="sibling-budget"
                data-testid="sibling-budget-input"
                type="number"
                min={1}
                className="h-8 w-24"
                defaultValue={row?.botInterplayBudget ?? DEFAULT_BOT_INTERPLAY_BUDGET}
                onChange={(e) => void onBudgetChange(e.target.value)}
                aria-label={t("sibling.budgetAria")}
              />
              <p className="text-xs text-muted-foreground">{t("sibling.budgetHelp")}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
