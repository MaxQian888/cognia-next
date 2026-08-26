"use client"

/**
 * Editor for a `TriggerPolicy` — "when does this bot answer, and when does it
 * stay quiet".
 *
 * Presentational and scope-agnostic: it renders a {@link TriggerPolicyDraft}
 * and reports edits. `AdapterTriggerPolicy` owns the bot-wide row and the
 * conversation override form owns the per-chat one, so the two scopes cannot
 * drift into different vocabularies for the same seven conditions and five
 * blockers.
 *
 * The evaluator (`lib/connectors/policy-eval.ts`) has implemented all twelve
 * since Task 26, but nothing wrote them: `AdapterInstanceRow.trigger` was
 * stamped once at create time and `ConversationOverrideRow.trigger` had no
 * writer at all, so inbound rate limits, keyword triggers and user
 * allow/blocklists were unreachable in the product.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
// Generic add/remove chip list; already the shape of every id/word/prefix list
// here. Reused in place rather than copied — see its docblock for the quirks
// (blur-commit, mousedown-before-click) that a second copy would lose.
import { ChipInput } from "@/components/settings/gateway/shared/chip-input"
import {
  fromTriggerPolicyDraft,
  triggerCoverageGaps,
  triggerDraftWarnings,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"

export interface TriggerPolicyEditorProps {
  value: TriggerPolicyDraft
  onChange: (next: TriggerPolicyDraft) => void
  /**
   * Disambiguates element ids when both scopes render on one screen (the
   * conversation override form sits inside a settings page that also lists the
   * bot's own policy).
   */
  idPrefix?: string
  disabled?: boolean
  /**
   * Which groups to render. The conversation scope overrides the three parts of
   * a policy independently — `rules`, `blockers` and `storeUnmatchedInDraftMode`
   * each REPLACE or inherit on their own — so it shows only the parts this chat
   * has actually taken over. Omitted means all three, which is the bot scope.
   */
  sections?: { rules?: boolean; blockers?: boolean; storeUnmatched?: boolean }
}

interface ToggleRowProps {
  id: string
  label: string
  help: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  children?: React.ReactNode
}

function ToggleRow({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
  children,
}: ToggleRowProps) {
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={id}>
      <div className="flex items-start gap-3">
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          data-testid={`${id}-switch`}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor={id} className="text-sm font-normal">
            {label}
          </Label>
          <p className="text-xs text-muted-foreground">{help}</p>
        </div>
      </div>
      {/* Parameters render only while the condition is on: an id list under a
       * switched-off rule reads as active configuration and is not. */}
      {checked && children ? <div className="pl-11">{children}</div> : null}
    </div>
  )
}

export function TriggerPolicyEditor({
  value,
  onChange,
  idPrefix = "trigger",
  disabled,
  sections,
}: TriggerPolicyEditorProps) {
  const t = useTranslations("settings.connections.triggerPolicy")

  const patchRules = (patch: Partial<TriggerPolicyDraft["rules"]>): void => {
    onChange({ ...value, rules: { ...value.rules, ...patch } })
  }
  const patchBlockers = (patch: Partial<TriggerPolicyDraft["blockers"]>): void => {
    onChange({ ...value, blockers: { ...value.blockers, ...patch } })
  }

  const showRules = sections?.rules ?? true
  const showBlockers = sections?.blockers ?? true
  const showStoreUnmatched = sections?.storeUnmatched ?? true

  // Gaps are a property of the RULES, so they only mean something where the
  // rules are the ones being edited. A chat that overrides blockers alone
  // inherits its rules, and reporting their gaps here would point the operator
  // at a control that is not on this screen.
  const gaps = showRules ? triggerCoverageGaps(fromTriggerPolicyDraft(value)) : []
  const warnings = triggerDraftWarnings(value).filter((warning) =>
    warning.startsWith("rate-limit") || warning.includes("blocklist") ? showBlockers : showRules
  )

  /** Parse a bounded positive integer, keeping the previous value on garbage. */
  const positiveInt = (raw: string, previous: number): number => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return previous
    return Math.max(0, Math.round(parsed))
  }

  return (
    <div className="space-y-4" data-testid={`${idPrefix}-policy-editor`}>
      {showRules && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">{t("rulesTitle")}</h4>
          <p className="text-xs text-muted-foreground">{t("rulesHelp")}</p>

          <ToggleRow
            id={`${idPrefix}-rule-private-default`}
            label={t("rules.privateDefault.label")}
            help={t("rules.privateDefault.help")}
            checked={value.rules.privateDefault}
            disabled={disabled}
            onCheckedChange={(checked) => patchRules({ privateDefault: checked })}
          />

          <ToggleRow
            id={`${idPrefix}-rule-self-mention`}
            label={t("rules.selfMention.label")}
            help={t("rules.selfMention.help")}
            checked={value.rules.selfMention}
            disabled={disabled}
            onCheckedChange={(checked) => patchRules({ selfMention: checked })}
          />

          <ToggleRow
            id={`${idPrefix}-rule-reply-to-bot`}
            label={t("rules.replyToBot.label")}
            help={t("rules.replyToBot.help")}
            checked={value.rules.replyToBot}
            disabled={disabled}
            onCheckedChange={(checked) => patchRules({ replyToBot: checked })}
          />

          <ToggleRow
            id={`${idPrefix}-rule-slash-command`}
            label={t("rules.slashCommand.label")}
            help={t("rules.slashCommand.help")}
            checked={value.rules.slashCommand.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchRules({ slashCommand: { ...value.rules.slashCommand, enabled: checked } })
            }
          >
            <ChipInput
              values={value.rules.slashCommand.prefixes}
              onCommit={(prefixes) =>
                patchRules({ slashCommand: { ...value.rules.slashCommand, prefixes } })
              }
              placeholder={t("rules.slashCommand.placeholder")}
              ariaLabel={t("rules.slashCommand.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-rule-keyword`}
            label={t("rules.keyword.label")}
            help={t("rules.keyword.help")}
            checked={value.rules.keyword.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchRules({ keyword: { ...value.rules.keyword, enabled: checked } })
            }
          >
            <div className="space-y-2">
              <ChipInput
                values={value.rules.keyword.words}
                onCommit={(words) => patchRules({ keyword: { ...value.rules.keyword, words } })}
                placeholder={t("rules.keyword.placeholder")}
                ariaLabel={t("rules.keyword.listAria")}
                addLabel={t("addAria")}
                removeLabel={t("removeAria")}
              />
              <div className="flex items-center gap-2">
                <Switch
                  id={`${idPrefix}-rule-keyword-case`}
                  checked={value.rules.keyword.caseInsensitive}
                  disabled={disabled}
                  onCheckedChange={(caseInsensitive) =>
                    patchRules({ keyword: { ...value.rules.keyword, caseInsensitive } })
                  }
                  data-testid={`${idPrefix}-rule-keyword-case-switch`}
                />
                <Label htmlFor={`${idPrefix}-rule-keyword-case`} className="text-xs font-normal">
                  {t("rules.keyword.caseInsensitive")}
                </Label>
              </div>
            </div>
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-rule-user-allowlist`}
            label={t("rules.userAllowlist.label")}
            help={t("rules.userAllowlist.help")}
            checked={value.rules.userAllowlist.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchRules({ userAllowlist: { ...value.rules.userAllowlist, enabled: checked } })
            }
          >
            <ChipInput
              values={value.rules.userAllowlist.userIds}
              onCommit={(userIds) =>
                patchRules({ userAllowlist: { ...value.rules.userAllowlist, userIds } })
              }
              placeholder={t("rules.userAllowlist.placeholder")}
              ariaLabel={t("rules.userAllowlist.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-rule-channel-allowlist`}
            label={t("rules.channelAllowlist.label")}
            help={t("rules.channelAllowlist.help")}
            checked={value.rules.channelAllowlist.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchRules({
                channelAllowlist: { ...value.rules.channelAllowlist, enabled: checked },
              })
            }
          >
            <ChipInput
              values={value.rules.channelAllowlist.channelIds}
              onCommit={(channelIds) =>
                patchRules({ channelAllowlist: { ...value.rules.channelAllowlist, channelIds } })
              }
              placeholder={t("rules.channelAllowlist.placeholder")}
              ariaLabel={t("rules.channelAllowlist.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>
        </section>
      )}

      {showBlockers && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">{t("blockersTitle")}</h4>
          <p className="text-xs text-muted-foreground">{t("blockersHelp")}</p>

          <ToggleRow
            id={`${idPrefix}-blocker-user-blocklist`}
            label={t("blockers.userBlocklist.label")}
            help={t("blockers.userBlocklist.help")}
            checked={value.blockers.userBlocklist.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchBlockers({
                userBlocklist: { ...value.blockers.userBlocklist, enabled: checked },
              })
            }
          >
            <ChipInput
              values={value.blockers.userBlocklist.userIds}
              onCommit={(userIds) =>
                patchBlockers({ userBlocklist: { ...value.blockers.userBlocklist, userIds } })
              }
              placeholder={t("blockers.userBlocklist.placeholder")}
              ariaLabel={t("blockers.userBlocklist.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-blocker-channel-blocklist`}
            label={t("blockers.channelBlocklist.label")}
            help={t("blockers.channelBlocklist.help")}
            checked={value.blockers.channelBlocklist.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchBlockers({
                channelBlocklist: { ...value.blockers.channelBlocklist, enabled: checked },
              })
            }
          >
            <ChipInput
              values={value.blockers.channelBlocklist.channelIds}
              onCommit={(channelIds) =>
                patchBlockers({
                  channelBlocklist: { ...value.blockers.channelBlocklist, channelIds },
                })
              }
              placeholder={t("blockers.channelBlocklist.placeholder")}
              ariaLabel={t("blockers.channelBlocklist.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-blocker-keyword-blocklist`}
            label={t("blockers.keywordBlocklist.label")}
            help={t("blockers.keywordBlocklist.help")}
            checked={value.blockers.keywordBlocklist.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchBlockers({
                keywordBlocklist: { ...value.blockers.keywordBlocklist, enabled: checked },
              })
            }
          >
            <ChipInput
              values={value.blockers.keywordBlocklist.words}
              onCommit={(words) =>
                patchBlockers({ keywordBlocklist: { ...value.blockers.keywordBlocklist, words } })
              }
              placeholder={t("blockers.keywordBlocklist.placeholder")}
              ariaLabel={t("blockers.keywordBlocklist.listAria")}
              addLabel={t("addAria")}
              removeLabel={t("removeAria")}
            />
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-blocker-rate-limit`}
            label={t("blockers.rateLimit.label")}
            help={t("blockers.rateLimit.help")}
            checked={value.blockers.rateLimit.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchBlockers({ rateLimit: { ...value.blockers.rateLimit, enabled: checked } })
            }
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-rate-user`} className="text-xs">
                  {t("blockers.rateLimit.perUser")}
                </Label>
                <Input
                  id={`${idPrefix}-rate-user`}
                  type="number"
                  min={1}
                  className="h-8"
                  disabled={disabled}
                  value={String(value.blockers.rateLimit.perUserPerMin)}
                  onChange={(e) =>
                    patchBlockers({
                      rateLimit: {
                        ...value.blockers.rateLimit,
                        perUserPerMin: positiveInt(
                          e.target.value,
                          value.blockers.rateLimit.perUserPerMin
                        ),
                      },
                    })
                  }
                  data-testid={`${idPrefix}-rate-user`}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-rate-channel`} className="text-xs">
                  {t("blockers.rateLimit.perChannel")}
                </Label>
                <Input
                  id={`${idPrefix}-rate-channel`}
                  type="number"
                  min={1}
                  className="h-8"
                  disabled={disabled}
                  value={String(value.blockers.rateLimit.perChannelPerMin)}
                  onChange={(e) =>
                    patchBlockers({
                      rateLimit: {
                        ...value.blockers.rateLimit,
                        perChannelPerMin: positiveInt(
                          e.target.value,
                          value.blockers.rateLimit.perChannelPerMin
                        ),
                      },
                    })
                  }
                  data-testid={`${idPrefix}-rate-channel`}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-rate-tenant`} className="text-xs">
                  {t("blockers.rateLimit.perTenant")}
                </Label>
                <Input
                  id={`${idPrefix}-rate-tenant`}
                  type="number"
                  min={1}
                  className="h-8"
                  disabled={disabled}
                  placeholder={t("blockers.rateLimit.perTenantPlaceholder")}
                  value={
                    value.blockers.rateLimit.perTenantPerMin === undefined
                      ? ""
                      : String(value.blockers.rateLimit.perTenantPerMin)
                  }
                  onChange={(e) =>
                    patchBlockers({
                      rateLimit: {
                        ...value.blockers.rateLimit,
                        // Blank means "no workspace ceiling", which is a real
                        // setting and not the same as zero.
                        perTenantPerMin:
                          e.target.value.trim() === ""
                            ? undefined
                            : positiveInt(
                                e.target.value,
                                value.blockers.rateLimit.perTenantPerMin ?? 0
                              ),
                      },
                    })
                  }
                  data-testid={`${idPrefix}-rate-tenant`}
                />
                <p className="text-xs text-muted-foreground">
                  {t("blockers.rateLimit.perTenantHelp")}
                </p>
              </div>
            </div>
          </ToggleRow>

          <ToggleRow
            id={`${idPrefix}-blocker-cooldown`}
            label={t("blockers.cooldown.label")}
            help={t("blockers.cooldown.help")}
            checked={value.blockers.cooldown.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              patchBlockers({ cooldown: { ...value.blockers.cooldown, enabled: checked } })
            }
          >
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-cooldown-secs`} className="text-xs">
                {t("blockers.cooldown.secs")}
              </Label>
              <Input
                id={`${idPrefix}-cooldown-secs`}
                type="number"
                min={0}
                className="h-8 sm:w-40"
                disabled={disabled}
                value={String(value.blockers.cooldown.secs)}
                onChange={(e) =>
                  patchBlockers({
                    cooldown: {
                      ...value.blockers.cooldown,
                      secs: positiveInt(e.target.value, value.blockers.cooldown.secs),
                    },
                  })
                }
                data-testid={`${idPrefix}-cooldown-secs`}
              />
            </div>
          </ToggleRow>
        </section>
      )}

      {showStoreUnmatched && (
        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch
            id={`${idPrefix}-store-unmatched`}
            checked={value.storeUnmatchedInDraftMode}
            disabled={disabled}
            onCheckedChange={(storeUnmatchedInDraftMode) =>
              onChange({ ...value, storeUnmatchedInDraftMode })
            }
            data-testid={`${idPrefix}-store-unmatched-switch`}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor={`${idPrefix}-store-unmatched`} className="text-sm font-normal">
              {t("storeUnmatched.label")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("storeUnmatched.help")}</p>
          </div>
        </div>
      )}

      {/* Diagnostics. Reported, never enforced: a deliberately narrow policy
       * (a connector speaking as a real person) has a private gap on purpose,
       * and a platform with no group scope has the group gap harmlessly. */}
      {gaps.length > 0 && (
        <Alert data-testid={`${idPrefix}-coverage-gaps`}>
          <AlertTriangleIcon className="size-4" />
          <AlertDescription>
            {/* Disc markers only once there is a list to mark — a lone bullet
             * beside the alert icon reads as a rendering slip. */}
            <ul className={gaps.length > 1 ? "list-disc space-y-1 pl-4" : "space-y-1"}>
              {gaps.map((gap) => (
                <li key={gap} data-testid={`${idPrefix}-gap-${gap}`}>
                  {t(`gaps.${gap}`)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert variant="destructive" data-testid={`${idPrefix}-warnings`}>
          <AlertTriangleIcon className="size-4" />
          <AlertDescription>
            <ul className={warnings.length > 1 ? "list-disc space-y-1 pl-4" : "space-y-1"}>
              {warnings.map((warning) => (
                <li key={warning} data-testid={`${idPrefix}-warning-${warning}`}>
                  {t(`warnings.${warning}`)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* A shape the per-kind slots cannot hold exactly. Surfaced rather than
       * hidden, because it is still part of what the bus evaluates. */}
      {value.residualRules.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-residual`}>
          {t("residual", { count: value.residualRules.length })}
        </p>
      )}
    </div>
  )
}
