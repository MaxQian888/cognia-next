"use client"

/**
 * Outbound authorization (ADR-0239): one shadow/enforce switch per category,
 * and what enforcing each would change.
 *
 * Each category has a switch: messaging (messages, mail, shares; phase 1),
 * GitHub writes (phase 2a) and browser submissions (phase 2b). Each starts in
 * shadow mode, the default, where the engine plans every outbound call and
 * changes nothing; the card says so ("observe only") and lists the sends,
 * writes or submissions enforcement would have drafted, parked, asked about or
 * refused, by sender and recipient. Enforcing one never enforces another. The
 * browser's switch also says what its check cannot see, and the global site
 * list ({@link OutboundSiteList}) sits below it.
 *
 * A recipient the device can name can be allowed in place, as the person's
 * own edit: a conversation or address into the sender's Bot list or the bot
 * account's list, a repository into the Bot's list for a Bot's own writes, else
 * into the list of the GitHub integration account the write went through. A
 * write that named no account (a `gh` command, a stack publish) offers each
 * account on the repository's host. A site goes into the Bot's list for a
 * Bot's own runs, else into the global site list. A person's own writes
 * (human receipts) are never listed: the click was the authorization.
 *
 * Turning enforcement on asks first and says how many observed sends of that
 * category it would change; turning it off does not. The settings and the
 * receipts live on the machine that runs the work, so while this shell drives
 * a paired Host the card explains that and edits nothing.
 */

import { useMemo, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
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
import { OutboundSiteList } from "@/components/settings/security/outbound-site-list"
import { useBotInstallations } from "@/hooks/bots/use-bot-installations"
import { useShadowReport, type ShadowReportView } from "@/hooks/outbound/use-shadow-report"
import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { ACTION_REVIEW_RETENTION_DAYS } from "@/lib/db/action-review-receipts"
import { allowShadowRecipient } from "@/lib/policy/action-review/allow-recipient"
import {
  outboundRecipientId,
  type OutboundCategory,
} from "@/lib/policy/action-review/outbound-targets"
import {
  readOutboundAuthorizationMode,
  type OutboundAuthorizationMode,
} from "@/lib/policy/action-review/policy"
import type {
  ShadowAllowInto,
  ShadowHeldOutcome,
  ShadowRecipientRow,
  ShadowSender,
} from "@/lib/policy/action-review/shadow-report"
import { useSettingsStore } from "@/stores/settings"

/** Every category has a switch, in this order. */
type SwitchedCategory = OutboundCategory
const SWITCHED_CATEGORIES: readonly SwitchedCategory[] = ["messaging", "github", "browser"]

/** The order outcomes are listed in: most disruptive last. */
const OUTCOME_ORDER: readonly ShadowHeldOutcome[] = ["ask", "draft", "park", "deny"]

function outcomeEntries(
  outcomes: Partial<Record<ShadowHeldOutcome, number>>
): [ShadowHeldOutcome, number][] {
  return OUTCOME_ORDER.flatMap((outcome) =>
    outcomes[outcome] ? [[outcome, outcomes[outcome]!] as [ShadowHeldOutcome, number]] : []
  )
}

function intoKey(into: ShadowAllowInto, fingerprint: string): string {
  const id =
    into.kind === "bot"
      ? into.installationId
      : into.kind === "adapter"
        ? into.adapterId
        : into.kind === "integration-account"
          ? into.accountId
          : ""
  return `${into.kind}:${id}:${fingerprint}`
}

export function OutboundAuthorizationCard() {
  const t = useTranslations("settings.security.outboundAuthorization")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const remote = useRemoteHostActive()
  const view = useShadowReport(!remote)
  const { rows: bots } = useBotInstallations()
  const [confirming, setConfirming] = useState<SwitchedCategory | null>(null)
  // What the dialog names; kept while it closes, so its text does not blank.
  const [asked, setAsked] = useState<SwitchedCategory>("messaging")
  const [saving, setSaving] = useState(false)
  const [allowing, setAllowing] = useState<ReadonlySet<string>>(() => new Set())

  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots])

  const setMode = async (category: SwitchedCategory, next: OutboundAuthorizationMode) => {
    setSaving(true)
    const permissions = settings?.agentPermissions ?? {}
    try {
      await save({
        agentPermissions:
          category === "messaging"
            ? { ...permissions, outboundAuthorization: next }
            : {
                ...permissions,
                outboundAuthorizationByCategory: {
                  ...(permissions.outboundAuthorizationByCategory ?? {}),
                  [category]: next,
                },
              },
      })
    } catch {
      toast.error(t("modeSaveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const ask = (category: SwitchedCategory) => {
    setAsked(category)
    setConfirming(category)
  }

  const senderLabel = (sender: ShadowSender, names: ShadowReportView | undefined): string => {
    switch (sender.kind) {
      case "bot":
        return t("sender.bot", { name: botNames.get(sender.id) ?? sender.id })
      case "task":
        return t("sender.task", { name: names?.taskNames.get(sender.id) ?? sender.id })
      case "workflow":
        return t("sender.workflow", { id: sender.id })
      case "notification":
        return t("sender.notification")
      case "plugin":
        return t("sender.plugin", { id: sender.id })
      case "team":
        return t("sender.team", { name: names?.teamNames.get(sender.id) ?? sender.id })
      case "chat":
        return t("sender.chat")
      case "bridge":
        return t("sender.bridge", { id: sender.id })
      case "other":
        return t("sender.other", { id: sender.id })
    }
  }

  const recipientName = (row: ShadowRecipientRow, names: ShadowReportView): string =>
    (row.target.kind === "conversation"
      ? names.conversationTitles.get(row.target.recipient)
      : undefined) ?? outboundRecipientId(row.target)

  const listName = (into: ShadowAllowInto, names: ShadowReportView): string => {
    switch (into.kind) {
      case "bot":
        return botNames.get(into.installationId) ?? into.installationId
      case "adapter":
        return names.adapterNames.get(into.adapterId) ?? into.adapterId
      case "integration-account":
        return names.accountNames.get(into.accountId) ?? into.accountId
      case "sites":
        return t("sites.title")
    }
  }

  const listLabel = (into: ShadowAllowInto, names: ShadowReportView): string => {
    switch (into.kind) {
      case "bot":
        return t("intoBot", { name: listName(into, names) })
      case "adapter":
        return t("intoAdapter", { name: listName(into, names) })
      case "integration-account":
        return t("intoAccount", { name: listName(into, names) })
      case "sites":
        return t("intoSites")
    }
  }

  const allow = async (row: ShadowRecipientRow, into: ShadowAllowInto, names: ShadowReportView) => {
    const key = intoKey(into, row.fingerprint)
    setAllowing((current) => new Set(current).add(key))
    const name = recipientName(row, names)
    try {
      await allowShadowRecipient(into, row.target)
      toast.success(t("allowed", { name, list: listLabel(into, names) }))
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

  const renderRow = (row: ShadowRecipientRow, names: ShadowReportView) => {
    const name = recipientName(row, names)
    return (
      <li key={row.fingerprint} className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className="font-normal">
          {t(
            `kind.${row.target.kind as "conversation" | "person" | "mail" | "repository" | "site"}`
          )}
        </Badge>
        <span className="min-w-0 truncate" title={row.target.recipient}>
          {name}
        </span>
        {row.target.kind === "conversation" || row.target.kind === "person" ? (
          <span className="text-xs text-muted-foreground">
            {t("via", { account: names.adapterNames.get(row.channel) ?? row.channel })}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {outcomeEntries(row.outcomes)
            .map(([outcome, count]) => t(`outcome.${outcome}`, { count }))
            .join(" · ")}
          {" · "}
          {t("lastSeen", { when: format.relativeTime(new Date(row.lastAt), now) })}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {row.allowInto ? (
            <>
              <span className="text-[11px] text-muted-foreground">
                {listLabel(row.allowInto, names)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={allowing.has(intoKey(row.allowInto, row.fingerprint))}
                aria-label={t("allowNamed", { name })}
                onClick={() => void allow(row, row.allowInto!, names)}
              >
                {t("allow")}
              </Button>
            </>
          ) : row.allowChoices?.length ? (
            <>
              <span className="text-[11px] text-muted-foreground">{t("chooseAccount")}</span>
              {row.allowChoices.map((into) => (
                <Button
                  key={intoKey(into, row.fingerprint)}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={allowing.has(intoKey(into, row.fingerprint))}
                  aria-label={t("allowNamedInto", { name, list: listName(into, names) })}
                  onClick={() => void allow(row, into, names)}
                >
                  {listName(into, names)}
                </Button>
              ))}
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t("noList")}</span>
          )}
        </span>
      </li>
    )
  }

  const renderCategory = (category: SwitchedCategory) => {
    const mode = readOutboundAuthorizationMode(settings, category)
    const report = view?.report[category]
    return (
      <section
        key={category}
        className="space-y-3"
        data-testid={`outbound-authorization-${category}`}
      >
        <div className="space-y-1.5">
          <SettingsToggle
            id={`outbound-authorization-enforce-${category}`}
            label={t(`categories.${category}.label`)}
            description={
              mode === "shadow"
                ? t(`categories.${category}.shadowHelp`)
                : t(`categories.${category}.enforceHelp`)
            }
            checked={mode === "enforce"}
            onCheckedChange={(checked) =>
              checked ? ask(category) : void setMode(category, "shadow")
            }
            disabled={remote || saving}
          />
          {mode === "shadow" ? (
            <Badge
              variant="secondary"
              data-testid={`outbound-authorization-observe-only-${category}`}
            >
              {t("observeOnly")}
            </Badge>
          ) : null}
          {category === "browser" ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="outbound-authorization-browser-limits"
            >
              {t("categories.browser.limits")}
            </p>
          ) : null}
        </div>

        {!remote ? (
          <div className="space-y-3" data-testid={`outbound-shadow-report-${category}`}>
            <div className="space-y-0.5">
              <h4 className="text-sm font-medium">{t("report.title")}</h4>
              <p className="text-xs text-muted-foreground">
                {t(`categories.${category}.reportDescription`, {
                  days: ACTION_REVIEW_RETENTION_DAYS,
                })}
              </p>
            </div>
            {!view || !report ? null : report.groups.length === 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid={`outbound-shadow-report-empty-${category}`}
              >
                {t(`categories.${category}.reportEmpty`)}
              </p>
            ) : (
              <ul className="space-y-3">
                {report.groups.map((group) => (
                  <li
                    key={`${group.sender.kind}:${group.sender.id}`}
                    className="space-y-1.5 rounded-md border p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{senderLabel(group.sender, view)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t("report.sends", { count: group.sends })}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {group.rows.map((row) => renderRow(row, view))}
                      {group.unrecognized.map((bucket) => (
                        <li
                          key={`unrecognized:${bucket.channel}`}
                          className="text-xs text-muted-foreground"
                          data-testid="outbound-shadow-unrecognized"
                        >
                          {category === "github"
                            ? t("unrecognizedRepositories", {
                                count: bucket.recipients,
                                sends: bucket.sends,
                              })
                            : category === "browser"
                              ? t("unrecognizedSites", {
                                  count: bucket.recipients,
                                  sends: bucket.sends,
                                })
                              : t("unrecognized", {
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
      </section>
    )
  }

  const confirmReport = view?.report[asked]
  const totals = confirmReport ? outcomeEntries(confirmReport.totals) : []

  return (
    <div className="space-y-4" data-testid="outbound-authorization">
      {remote ? (
        <p className="text-sm text-muted-foreground" data-testid="outbound-authorization-remote">
          {t("remoteHost")}
        </p>
      ) : null}

      {SWITCHED_CATEGORIES.map(renderCategory)}

      <OutboundSiteList disabled={remote} />

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`categories.${asked}.confirmTitle`)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`categories.${asked}.confirmBehaviour`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 text-sm" data-testid="outbound-authorization-confirm-impact">
            {confirmReport && confirmReport.sends > 0 ? (
              <>
                <p>{t("confirm.impact", { count: confirmReport.sends })}</p>
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
              onClick={() => void setMode(asked, "enforce")}
            >
              {t("confirm.enable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
