"use client"

import { useState } from "react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Badge, Button } from "@cognia/plugin-ui"

import { followRate, sampleKey, showsDilution, verdictOf } from "../adherence/backtest"
import { describeMatcher } from "../adherence/checks"
import { PLUGIN_ID } from "../model"
import type { GovernanceRuntime } from "../runtime/runtime"
import { act } from "./act"
import { formatDateTime, percent } from "./format"
import type { GovernanceData } from "./use-governance"

export interface AdherenceTabProps {
  runtime: GovernanceRuntime
  workspaceId: string | null
  data: GovernanceData
  busy: boolean
}

export function AdherenceTab({ runtime, workspaceId, data, busy }: AdherenceTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const familyLabel = (family: string) => t(`family.${family}`)
  const locale = t("format.locale")
  const [open, setOpen] = useState<string | null>(null)
  const checks = data.checks?.checks ?? []
  const enforced = new Set(
    data.rules.filter((rule) => rule.workspaceId === workspaceId).map((rule) => rule.check.id)
  )

  return (
    <div className="space-y-3 p-3" data-testid="governance-adherence">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act(runtime.deriveChecks(workspaceId), t)}
        >
          {data.checks ? t("adherence.rederive") : t("adherence.derive")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !data.checks || checks.length === 0}
          onClick={() => act(runtime.backtest(workspaceId), t)}
        >
          {t("adherence.replay")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("adherence.hint")}</p>
      {data.checks && (
        <p className="text-xs text-muted-foreground">
          {t("adherence.derivedSummary", {
            checks: checks.length,
            notCheckable: data.checks.notCheckable,
            rejected: data.checks.rejected,
            at: formatDateTime(locale, data.checks.derivedAt),
          })}
          {data.adherence
            ? ` · ${t("adherence.replayedSummary", {
                sessions: data.adherence.sessions,
                at: formatDateTime(locale, data.adherence.ranAt),
              })}`
            : ""}
        </p>
      )}
      {!data.checks ? (
        <p className="text-xs text-muted-foreground">{t("adherence.none")}</p>
      ) : checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("adherence.noChecks")}</p>
      ) : (
        <ul className="space-y-2">
          {checks.map((check) => {
            const result = data.results.get(check.id)
            const verdict = result ? verdictOf(check, result) : undefined
            return (
              <li
                key={check.id}
                className="space-y-1.5 rounded-md border p-2"
                data-check-id={check.id}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium">{check.summary}</span>
                  {verdict && (
                    <Badge
                      variant={verdict === "not-followed" ? "destructive" : "outline"}
                      className="text-[10px]"
                    >
                      {t(`verdict.${verdict}`)}
                    </Badge>
                  )}
                  {enforced.has(check.id) && (
                    <Badge className="text-[10px]">{t("adherence.enforced")}</Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {check.rule.surfaceName}:{check.rule.startLine} · {t(`checkKind.${check.kind}`)} ·{" "}
                  {t(`scope.${check.scope}`)} · {describeMatcher(check.trigger, familyLabel)}
                  {check.expect ? ` → ${describeMatcher(check.expect, familyLabel)}` : ""}
                </p>
                <blockquote className="border-l-2 pl-2 text-xs">{check.rule.text}</blockquote>
                {result && (
                  <p className="text-xs">
                    {t("adherence.resultLine", {
                      rate: percent(followRate(result)),
                      followed: result.followed,
                      opportunities: result.opportunities,
                      sessions: result.sessionsTriggered,
                      scanned: result.sessionsScanned,
                    })}
                    {result.excluded > 0
                      ? ` · ${t("adherence.excluded", { count: result.excluded })}`
                      : ""}
                  </p>
                )}
                {result && result.excluded > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => act(runtime.clearFalseMatches(check.id), t)}
                  >
                    {t("adherence.clearLabels")}
                  </Button>
                )}
                {result && showsDilution(result) && result.dilution && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t("adherence.dilution", {
                      early: percent(result.dilution.early),
                      late: percent(result.dilution.late),
                    })}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {result && result.samples.length > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpen(open === check.id ? null : check.id)}
                    >
                      {open === check.id
                        ? t("adherence.hideSamples")
                        : t("adherence.showSamples", { count: result.samples.length })}
                    </Button>
                  )}
                  {!enforced.has(check.id) &&
                    (["remind", "block"] as const).map((mode) => (
                      <Button
                        key={mode}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => act(runtime.adopt(check, mode, workspaceId), t)}
                      >
                        {t(`enforcement.adopt.${mode}`)}
                      </Button>
                    ))}
                </div>
                {open === check.id && result && (
                  <ul className="space-y-1" data-testid="governance-samples">
                    {result.samples.map((sample) => {
                      const key = sampleKey(check.id, sample.sessionId, sample.order)
                      return (
                        <li
                          key={key}
                          className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-[11px]"
                        >
                          <Badge
                            variant={sample.outcome === "violated" ? "destructive" : "outline"}
                            className="text-[10px]"
                          >
                            {t(`outcome.${sample.outcome}`)}
                          </Badge>
                          <code className="min-w-0 flex-1 truncate">{sample.call}</code>
                          <span className="text-muted-foreground">
                            {t("adherence.turn", { turn: sample.turn + 1 })}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={() =>
                              act(
                                runtime.setFalseMatch(
                                  check.id,
                                  sample.sessionId,
                                  sample.order,
                                  true
                                ),
                                t
                              )
                            }
                          >
                            {t("adherence.falseMatch")}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {data.falseMatches.size > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t("adherence.labels", { count: data.falseMatches.size })}
        </p>
      )}
    </div>
  )
}
