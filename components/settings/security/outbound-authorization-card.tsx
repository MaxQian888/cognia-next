"use client"

/**
 * Outbound authorization (ADR-0239): the shadow/enforce switch and what
 * enforcement would change.
 *
 * In shadow mode, the default, the engine plans every outbound tool call and
 * connector delivery and changes nothing; the card says so ("observe only")
 * and lists the sends enforcement would have drafted, parked, asked about or
 * refused, by sender and recipient. A recipient the device can name can be
 * allowed in place, which writes the sender's Bot list or the bot account's
 * list as the person's own edit; one it cannot name is counted.
 *
 * Turning enforcement on asks first and says how many observed sends it would
 * change; turning it off does not. The setting and the receipts live on the
 * machine that runs the work, so while this shell drives a paired Host the
 * card explains that and edits nothing.
 */

import { useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsToggle } from "@/components/settings/common/settings-section"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useBotInstallations } from "@/hooks/bots/use-bot-installations"
import { useShadowReport, type ShadowReportView } from "@/hooks/outbound/use-shadow-report"
import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { ACTION_REVIEW_RETENTION_DAYS } from "@/lib/db/action-review-receipts"
import { allowShadowRecipient } from "@/lib/policy/action-review/allow-recipient"
import { outboundRecipientId } from "@/lib/policy/action-review/outbound-targets"
import { readOutboundAuthorizationMode } from "@/lib/policy/action-review/policy"
import type {
  ShadowAllowInto,
  ShadowHeldOutcome,
  ShadowRecipientRow,
  ShadowSender,
} from "@/lib/policy/action-review/shadow-report"
import { useSettingsStore } from "@/stores/settings"

/** The order outcomes are listed in: most disruptive last. */
const OUTCOME_ORDER: readonly ShadowHeldOutcome[] = ["ask", "draft", "park", "deny"]

function outcomeEntries(
  outcomes: Partial<Record<ShadowHeldOutcome, number>>
): [ShadowHeldOutcome, number][] {
  return OUTCOME_ORDER.flatMap((outcome) =>
    outcomes[outcome] ? [[outcome, outcomes[outcome]!] as [ShadowHeldOutcome, number]] : []
  )
}

export function OutboundAuthorizationCard() {
  const t = useTranslations("settings.security.outboundAuthorization")
  const format = useFormatter()
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const remote = useRemoteHostActive()
  const view = useShadowReport(!remote)
  const { rows: bots } = useBotInstallations()
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [allowing, setAllowing] = useState<ReadonlySet<string>>(() => new Set())

  const mode = readOutboundAuthorizationMode(settings)
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots])

  const setMode = async (next: "shadow" | "enforce") => {
    setSaving(true)
    try {
      await save({
        agentPermissions: { ...(settings?.agentPermissions ?? {}), outboundAuthorization: next },
      })
    } catch {
      toast.error(t("modeSaveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const senderLabel = (sender: ShadowSender): string => {
    switch (sender.kind) {
      case "bot":
        return t("sender.bot", { name: botNames.get(sender.id) ?? sender.id })
      case "task":
        return t("sender.task", { name: view?.taskNames.get(sender.id) ?? sender.id })
      case "workflow":
        return t("sender.workflow", { id: sender.id })
      case "notification":
        return t("sender.notification")
      case "plugin":
        return t("sender.plugin", { id: sender.id })
      case "chat":
        return t("sender.chat")
      case "other":
        return t("sender.other", { id: sender.id })
    }
  }

  const recipientName = (row: ShadowRecipientRow, names: ShadowReportView): string =>
    (row.target.kind === "conversation"
      ? names.conversationTitles.get(row.target.recipient)
      : undefined) ?? outboundRecipientId(row.target)

  const listLabel = (into: ShadowAllowInto, names: ShadowReportView): string =>
    into.kind === "bot"
      ? t("intoBot", { name: botNames.get(into.installationId) ?? into.installationId })
      : t("intoAdapter", { name: names.adapterNames.get(into.adapterId) ?? into.adapterId })

  const allow = async (row: ShadowRecipientRow, names: ShadowReportView) => {
    if (!row.allowInto) return
    const key = `${row.allowInto.kind}:${row.fingerprint}`
    setAllowing((current) => new Set(current).add(key))
    const name = recipientName(row, names)
    try {
      await allowShadowRecipient(row.allowInto, row.target)
      toast.success(t("allowed", { name, list: listLabel(row.allowInto, names) }))
    } catch (error) {
      toast.error(
        t("allowFailed", { reason: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setAllowing((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const report = view?.report
  const totals = report ? outcomeEntries(report.totals) : []

  return (
    <div className="space-y-4" data-testid="outbound-authorization">
      {remote ? (
        <p className="text-sm text-muted-foreground" data-testid="outbound-authorization-remote">
          {t("remoteHost")}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <SettingsToggle
          id="outbound-authorization-enforce"
          label={t("enforce.label")}
          description={mode === "shadow" ? t("enforce.shadowHelp") : t("enforce.enforceHelp")}
          checked={mode === "enforce"}
          onCheckedChange={(checked) => (checked ? setConfirming(true) : void setMode("shadow"))}
          disabled={remote || saving}
        />
        {mode === "shadow" ? (
          <Badge variant="secondary" data-testid="outbound-authorization-observe-only">
            {t("observeOnly")}
          </Badge>
        ) : null}
      </div>

      {!remote ? (
        <div className="space-y-3" data-testid="outbound-shadow-report">
          <div className="space-y-0.5">
            <h4 className="text-sm font-medium">{t("report.title")}</h4>
            <p className="text-xs text-muted-foreground">
              {t("report.description", { days: ACTION_REVIEW_RETENTION_DAYS })}
            </p>
          </div>
          {!view ? null : view.report.groups.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="outbound-shadow-report-empty">
              {t("report.empty")}
            </p>
          ) : (
            <ul className="space-y-3">
              {view.report.groups.map((group) => (
                <li
                  key={`${group.sender.kind}:${group.sender.id}`}
                  className="space-y-1.5 rounded-md border p-3"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{senderLabel(group.sender)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("report.sends", { count: group.sends })}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {group.rows.map((row) => {
                      const name = recipientName(row, view)
                      const busy = row.allowInto
                        ? allowing.has(`${row.allowInto.kind}:${row.fingerprint}`)
                        : false
                      return (
                        <li
                          key={row.fingerprint}
                          className="flex flex-wrap items-center gap-2 text-sm"
                        >
                          <Badge variant="outline" className="font-normal">
                            {t(`kind.${row.target.kind as "conversation" | "person" | "mail"}`)}
                          </Badge>
                          <span className="min-w-0 truncate" title={row.target.recipient}>
                            {name}
                          </span>
                          {row.target.kind !== "mail" ? (
                            <span className="text-xs text-muted-foreground">
                              {t("via", {
                                account: view.adapterNames.get(row.channel) ?? row.channel,
                              })}
                            </span>
                          ) : null}
                          <span className="text-xs text-muted-foreground">
                            {outcomeEntries(row.outcomes)
                              .map(([outcome, count]) => t(`outcome.${outcome}`, { count }))
                              .join(" · ")}
                            {" · "}
                            {t("lastSeen", { when: format.relativeTime(new Date(row.lastAt)) })}
                          </span>
                          <span className="ml-auto flex items-center gap-2">
                            {row.allowInto ? (
                              <>
                                <span className="text-[11px] text-muted-foreground">
                                  {listLabel(row.allowInto, view)}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  aria-label={t("allowNamed", { name })}
                                  onClick={() => void allow(row, view)}
                                >
                                  {t("allow")}
                                </Button>
                              </>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t("noList")}
                              </span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                    {group.unrecognized.map((bucket) => (
                      <li
                        key={`unrecognized:${bucket.channel}`}
                        className="text-xs text-muted-foreground"
                        data-testid="outbound-shadow-unrecognized"
                      >
                        {t("unrecognized", {
                          count: bucket.recipients,
                          sends: bucket.sends,
                          account: view.adapterNames.get(bucket.channel) ?? bucket.channel,
                        })}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.behaviour")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 text-sm" data-testid="outbound-authorization-confirm-impact">
            {report && report.sends > 0 ? (
              <>
                <p>{t("confirm.impact", { count: report.sends })}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {totals.map(([outcome, count]) => (
                    <li key={outcome}>{t(`confirm.outcome.${outcome}`, { count })}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t("confirm.noImpact")}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="outbound-authorization-confirm"
              onClick={() => void setMode("enforce")}
            >
              {t("confirm.enable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
