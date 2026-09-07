"use client"

/**
 * The ceiling this Bot runs under, and which layer set each part of it.
 *
 * The provenance is the point. A ceiling on its own answers "what can this Bot
 * do", which a user can usually guess. What they cannot guess is WHY, and
 * "your organisation set this" and "the plugin author set this" lead to two
 * completely different next steps. `resolveBotPolicy` has recorded the layer
 * per field since it was written and nothing rendered it.
 *
 * Refusals are shown too. A layer that asked to WIDEN something was overruled,
 * and that is not an error to hide: it is the difference between "the plugin
 * never asked for this" and "the plugin asked and was told no".
 *
 * Read-only. A ceiling can only be narrowed, and the narrowing an installation
 * is allowed to add is `policyGrant`, which belongs with the rest of the
 * installation's configuration rather than in the explanation of the fold.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { FactList, FactRow } from "@/components/surface/fact-list"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotPolicyLayerName } from "@/lib/bot/policy/ceilings"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

/**
 * The fields in the order a reader wants them: what it may do, then how long
 * and how much, then the two switches.
 *
 * A `satisfies` over the policy's own keys, so a field added to
 * `PluginBotPolicyV1` without a row here is a type error rather than a value
 * that silently stops being shown.
 */
const POLICY_FIELDS = [
  "maxAuthority",
  "maxAutonomy",
  "maxRunDurationMs",
  "maxRunCostUsd",
  "maxConcurrentRuns",
  "requireApprovalForWrites",
  "allowSelfTriggering",
] as const satisfies readonly (keyof PluginBotPolicyV1)[]

type PolicyField = (typeof POLICY_FIELDS)[number]

function LayerBadge({ layer }: { layer: BotPolicyLayerName }) {
  const t = useTranslations("bots")
  return (
    <Badge variant="outline" className="ml-1.5 font-normal text-muted-foreground">
      {t(`policyLayer.${layer}`)}
    </Badge>
  )
}

export function BotPolicySection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const resolution = row.policy

  if (!resolution) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("policy.orphanTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("policy.orphanBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const { policy, provenance, refusals } = resolution
  const stated = POLICY_FIELDS.filter((field) => policy[field] !== undefined)

  /**
   * "No layer had an opinion" is a real answer and not an empty state. It
   * means the Bot runs under the defaults every other run uses, which is worth
   * saying rather than leaving a blank card that reads as a load failure.
   */
  if (stated.length === 0 && refusals.length === 0) {
    return (
      <Empty className="border-none py-4">
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("policy.unconstrainedTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("policy.unconstrainedBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const render = (field: PolicyField) => {
    const value = policy[field]
    if (field === "maxRunDurationMs") return t("policy.duration", { seconds: Number(value) / 1000 })
    if (field === "maxRunCostUsd") return t("policy.cost", { usd: Number(value) })
    if (typeof value === "boolean") return t(value ? "policy.yes" : "policy.no")
    return String(value)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="bot-policy">
      <FactList>
        {stated.map((field) => (
          <FactRow key={field} label={t(`policyField.${field}`)}>
            <span className="inline-flex flex-wrap items-baseline">
              {render(field)}
              {provenance[field] ? <LayerBadge layer={provenance[field]} /> : null}
            </span>
          </FactRow>
        ))}
      </FactList>

      {refusals.length > 0 ? (
        <div className="border-t pt-2.5" data-testid="bot-policy-refusals">
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("policy.refusalsHint")}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {refusals.map((refusal) => (
              <li
                key={`${refusal.layer}:${refusal.field}`}
                className="text-xs"
                data-testid={`bot-policy-refusal-${refusal.field}`}
              >
                {t("policy.refusal", {
                  layer: t(`policyLayer.${refusal.layer}`),
                  field: t(`policyField.${refusal.field as PolicyField}`),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
