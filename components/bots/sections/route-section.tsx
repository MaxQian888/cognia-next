"use client"

/**
 * The model lane of an installation's external agents.
 *
 * Its own section, not a field in the settings form: the route decides
 * whether model traffic passes the gateway's per-request sensitive-data check
 * and whether the cost ceiling is a hard limit, and the settings form is the
 * plugin's own schema. A plugin can neither choose nor change it; the write
 * goes through `setBotExecutionRoute`, which a paired client relays to its
 * Host like every other lifecycle write.
 *
 * Three answers, each stated plainly rather than defaulted silently:
 *  - not chosen: a gateway-capable agent will not run (the Bot reports that
 *    it needs setup), which is why this section shows the setup error;
 *  - a Cognia model: the gateway lane;
 *  - the agent's own login: an explicit, labelled trade-off.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { ModelSelect } from "@/components/shared/model-select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  useBotLifecycleActions,
  useBotLifecycleReadiness,
} from "@/hooks/bots/use-bot-lifecycle-actions"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotExecutionRouteInput } from "@/lib/bot/control-writes"

type RouteMode = "unset" | "gateway" | "native"

interface RouteDraft {
  id: string
  mode: RouteMode
  providerId: string
  modelId: string
}

function draftFromRow(row: BotConsoleRow): RouteDraft {
  const route = row.executionRoute
  if (route?.mode === "gateway")
    return { id: row.id, mode: "gateway", providerId: route.providerId, modelId: route.modelId }
  return { id: row.id, mode: route?.mode ?? "unset", providerId: "", modelId: "" }
}

function routeFromDraft(draft: RouteDraft): BotExecutionRouteInput | null {
  if (draft.mode === "native") return { mode: "native" }
  if (draft.mode === "gateway")
    return { mode: "gateway", providerId: draft.providerId, modelId: draft.modelId }
  return null
}

function sameRoute(row: BotConsoleRow, draft: RouteDraft): boolean {
  return JSON.stringify(routeFromDraft(draftFromRow(row))) === JSON.stringify(routeFromDraft(draft))
}

export function BotRouteSection({ row }: { row: BotConsoleRow }) {
  const t = useTranslations("bots")
  const readiness = useBotLifecycleReadiness()
  const actions = useBotLifecycleActions()
  // Keyed on the installation, so switching rows never carries a draft over.
  const [edited, setEdited] = useState<RouteDraft | null>(null)
  const draft = edited?.id === row.id ? edited : draftFromRow(row)
  const busy = actions.pending.has(`route:${row.id}`)
  const disabled = !readiness.can || busy
  const incomplete = draft.mode === "gateway" && (!draft.providerId || !draft.modelId)
  const unchanged = sameRoute(row, draft)
  const setupError =
    row.status === "needs_setup" && row.monitor?.lastError ? row.monitor.lastError : undefined

  return (
    <div className="flex flex-col gap-3" data-testid="bot-route">
      {setupError ? (
        <Alert variant="destructive" data-testid="bot-route-setup-error">
          <AlertDescription>{t("route.needsSetup", { reason: setupError })}</AlertDescription>
        </Alert>
      ) : null}
      <RadioGroup
        value={draft.mode}
        onValueChange={(mode) => setEdited({ ...draft, mode: mode as RouteMode })}
        disabled={disabled}
        aria-label={t("route.title")}
        className="gap-3"
      >
        {(["unset", "gateway", "native"] as const).map((mode) => (
          <div key={mode} className="flex items-start gap-2">
            <RadioGroupItem
              id={`bot-route-${row.id}-${mode}`}
              value={mode}
              className="mt-0.5"
              data-testid={`bot-route-${mode}`}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={`bot-route-${row.id}-${mode}`}>{t(`route.${mode}`)}</Label>
              <p className="text-xs text-muted-foreground">{t(`route.${mode}Hint`)}</p>
            </div>
          </div>
        ))}
      </RadioGroup>
      {draft.mode === "gateway" ? (
        <div className="flex flex-col gap-1.5 pl-6">
          <Label className="text-xs">{t("route.model")}</Label>
          <ModelSelect
            model={draft.modelId}
            provider={draft.providerId}
            onSelect={({ providerId, modelId }) => setEdited({ ...draft, providerId, modelId })}
            placeholder={t("route.selectModel")}
            disabled={disabled}
            side="bottom"
            align="start"
          />
        </div>
      ) : null}
      {draft.mode === "native" ? (
        <Alert data-testid="bot-route-native-warning">
          <AlertDescription>{t("route.nativeWarning")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={disabled || incomplete || unchanged}
          onClick={async () => {
            if (await actions.saveRoute(row.id, routeFromDraft(draft))) setEdited(null)
          }}
          data-testid="bot-route-save"
        >
          {t("route.save")}
        </Button>
      </div>
      {!readiness.can ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t(`write.reason.${readiness.availability.reason}`)}
        </p>
      ) : null}
    </div>
  )
}
