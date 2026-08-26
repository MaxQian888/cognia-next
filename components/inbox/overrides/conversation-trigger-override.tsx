"use client"

/**
 * Per-conversation trigger override.
 *
 * `ConversationOverrideRow.trigger` is a `Partial<TriggerPolicy>` and
 * `policy-resolve.ts` merges it with REPLACE-if-defined semantics per key, so
 * the three parts of a policy are independent: a chat can take over the
 * conditions, the blockers, or whether unmatched messages are kept, and inherit
 * the rest. Three inherit switches is what that model actually looks like — one
 * master switch would force a chat that only wants a tighter rate limit to
 * freeze the bot's conditions too, and they would then stop tracking the bot.
 *
 * This had no writer at all before: the field was declared, merged and
 * evaluated, and nothing in the product could set it.
 *
 * Fully controlled — the effective policy is `baseline` merged with `value`,
 * and every edit is reported straight back as the parts this chat has taken
 * over. No local draft, so the parent's state is always the whole truth.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { TriggerPolicyEditor } from "@/components/settings/connections/forms/trigger-policy-editor"
import {
  fromTriggerPolicyDraft,
  toTriggerPolicyDraft,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"
import type { TriggerPolicy } from "@/types/connectors/policy"

export interface ConversationTriggerOverrideProps {
  /** What this chat inherits: the bot's policy with the character layer applied. */
  baseline: TriggerPolicy
  value: Partial<TriggerPolicy> | undefined
  onChange: (next: Partial<TriggerPolicy> | undefined) => void
}

/** The effective policy this chat evaluates against, mirroring `resolveBinding`. */
export function mergeConversationTrigger(
  baseline: TriggerPolicy,
  value: Partial<TriggerPolicy> | undefined
): TriggerPolicy {
  return {
    rules: value?.rules ?? baseline.rules,
    blockers: value?.blockers ?? baseline.blockers,
    storeUnmatchedInDraftMode:
      value?.storeUnmatchedInDraftMode ?? baseline.storeUnmatchedInDraftMode,
  }
}

export function ConversationTriggerOverride({
  baseline,
  value,
  onChange,
}: ConversationTriggerOverrideProps) {
  const t = useTranslations("settings.connections.triggerPolicy")

  const overridesRules = value?.rules !== undefined
  const overridesBlockers = value?.blockers !== undefined
  const overridesStoreUnmatched = value?.storeUnmatchedInDraftMode !== undefined
  const effective = mergeConversationTrigger(baseline, value)
  const draft = toTriggerPolicyDraft(effective)

  /**
   * Rebuild the override from a whole policy, keeping only the parts this chat
   * has taken over. An empty result becomes `undefined` rather than `{}`:
   * `resolveBinding` treats an empty object as "no override", and persisting one
   * would leave a row claiming a customisation it does not have.
   */
  const emit = (
    policy: TriggerPolicy,
    parts: { rules: boolean; blockers: boolean; storeUnmatched: boolean }
  ): void => {
    const next: Partial<TriggerPolicy> = {}
    if (parts.rules) next.rules = policy.rules
    if (parts.blockers) next.blockers = policy.blockers
    if (parts.storeUnmatched) next.storeUnmatchedInDraftMode = policy.storeUnmatchedInDraftMode
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }

  const currentParts = {
    rules: overridesRules,
    blockers: overridesBlockers,
    storeUnmatched: overridesStoreUnmatched,
  }

  const setPart = (part: keyof typeof currentParts, enabled: boolean): void => {
    // Switching a part ON seeds it from what the chat is already evaluating, so
    // the first edit starts from the bot's answer rather than from an empty
    // policy that would silence the chat the moment it is saved.
    emit(effective, { ...currentParts, [part]: enabled })
  }

  const onDraftChange = (next: TriggerPolicyDraft): void => {
    emit(fromTriggerPolicyDraft(next), currentParts)
  }

  return (
    <div className="space-y-3" data-testid="conversation-trigger-override">
      <div className="space-y-0.5">
        <h4 className="text-sm font-medium">{t("title")}</h4>
        <p className="text-xs text-muted-foreground">{t("conversationScopeHelp")}</p>
      </div>

      <div className="space-y-2">
        {(
          [
            ["rules", overridesRules],
            ["blockers", overridesBlockers],
            ["storeUnmatched", overridesStoreUnmatched],
          ] as Array<[keyof typeof currentParts, boolean]>
        ).map(([part, checked]) => (
          <div key={part} className="flex items-center gap-2">
            <Switch
              id={`conv-trigger-override-${part}`}
              checked={checked}
              onCheckedChange={(next) => setPart(part, next)}
              data-testid={`conv-trigger-override-${part}-switch`}
            />
            <Label htmlFor={`conv-trigger-override-${part}`} className="text-xs font-normal">
              {t(`overrideParts.${part}`)}
            </Label>
          </div>
        ))}
      </div>

      {/* Nothing overridden means nothing to edit — the bot's own policy is
       * shown where it is edited, not mirrored read-only here. */}
      {(overridesRules || overridesBlockers || overridesStoreUnmatched) && (
        <TriggerPolicyEditor
          idPrefix="conv-trigger"
          value={draft}
          onChange={onDraftChange}
          sections={{
            rules: overridesRules,
            blockers: overridesBlockers,
            storeUnmatched: overridesStoreUnmatched,
          }}
        />
      )}
    </div>
  )
}
