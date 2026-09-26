"use client"

/**
 * Agent-scoped `Character.platformDefaults` editor — what a messaging bot
 * wearing this agent does by default.
 *
 * `resolveBinding` (`lib/connectors/policy-resolve.ts`) layers adapter default
 * → agent `platformDefaults` → conversation override. `mode` replaces the bot's
 * default mode when set; `trigger` is a `Partial<TriggerPolicy>` whose three
 * parts (conditions, blockers, keep-unmatched) each replace the bot's part
 * independently. So every piece here has its own inherit state, and a result
 * with nothing overridden is written as `undefined`, never `{}`.
 *
 * The trigger parts are edited with the shared {@link TriggerPolicyEditor} and
 * merged with {@link mergeConversationTrigger}, the same pieces the
 * per-conversation override uses. The agent is not bound to one bot, so a part
 * that is taken over starts from the standard private-chat profile rather than
 * from any particular bot's policy — never from an empty policy, which would
 * silence the bot the moment it is saved.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { TriggerPolicyEditor } from "@/components/settings/connections/forms/trigger-policy-editor"
import { mergeConversationTrigger } from "@/components/inbox/overrides/conversation-trigger-override"
import { fromTriggerPolicyDraft, toTriggerPolicyDraft } from "@/lib/connectors/trigger-policy-draft"
import type { CharacterPlatformDefaults } from "@/types/connectors/binding"
import {
  ALL_MODES,
  defaultPrivateChatPolicy,
  type ConnectorMode,
  type TriggerPolicy,
} from "@/types/connectors/policy"
import { InheritSelect } from "./inherit-select"

type TriggerPart = "rules" | "blockers" | "storeUnmatched"

const PARTS: readonly TriggerPart[] = ["rules", "blockers", "storeUnmatched"]

/** Rebuild a `platformDefaults` value, dropping unset pieces; nothing left → `undefined`. */
export function composePlatformDefaults(
  current: CharacterPlatformDefaults | undefined,
  next: Partial<CharacterPlatformDefaults>
): CharacterPlatformDefaults | undefined {
  const merged: CharacterPlatformDefaults = { ...current, ...next }
  if (merged.mode === undefined) delete merged.mode
  if (merged.trigger === undefined) delete merged.trigger
  return Object.keys(merged).length > 0 ? merged : undefined
}

/** Keep only the trigger parts that are taken over; none → `undefined`. */
export function pickTriggerParts(
  policy: TriggerPolicy,
  parts: Record<TriggerPart, boolean>
): Partial<TriggerPolicy> | undefined {
  const out: Partial<TriggerPolicy> = {}
  if (parts.rules) out.rules = policy.rules
  if (parts.blockers) out.blockers = policy.blockers
  if (parts.storeUnmatched) out.storeUnmatchedInDraftMode = policy.storeUnmatchedInDraftMode
  return Object.keys(out).length > 0 ? out : undefined
}

export interface PlatformDefaultsOverrideProps {
  value: CharacterPlatformDefaults | undefined
  onChange: (next: CharacterPlatformDefaults | undefined) => void
}

export function PlatformDefaultsOverride({ value, onChange }: PlatformDefaultsOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.platformDefaults")
  const trigger = value?.trigger
  const currentParts: Record<TriggerPart, boolean> = {
    rules: trigger?.rules !== undefined,
    blockers: trigger?.blockers !== undefined,
    storeUnmatched: trigger?.storeUnmatchedInDraftMode !== undefined,
  }
  const effective = mergeConversationTrigger(defaultPrivateChatPolicy(), trigger)
  const anyPart = PARTS.some((part) => currentParts[part])

  const emitTrigger = (policy: TriggerPolicy, parts: Record<TriggerPart, boolean>) =>
    onChange(composePlatformDefaults(value, { trigger: pickTriggerParts(policy, parts) }))

  return (
    <div className="space-y-3" data-testid="agent-override-platform-defaults">
      <div className="space-y-0.5">
        <Label className="text-xs font-medium">{t("title")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      </div>
      <InheritSelect<ConnectorMode>
        id="agent-override-platform-mode"
        label={t("mode.label")}
        description={t("mode.description")}
        inheritLabel={t("mode.inherit")}
        value={value?.mode}
        options={ALL_MODES.map((mode) => ({ value: mode, label: t(`mode.${mode}`) }))}
        onChange={(mode) => onChange(composePlatformDefaults(value, { mode }))}
      />
      <div className="space-y-2">
        <p className="text-[10px] text-muted-foreground">{t("triggerDescription")}</p>
        {PARTS.map((part) => {
          const id = `agent-platform-trigger-${part}`
          return (
            <div key={part} className="flex items-center gap-2">
              <Switch
                id={id}
                checked={currentParts[part]}
                onCheckedChange={(checked) =>
                  emitTrigger(effective, { ...currentParts, [part]: checked })
                }
                aria-label={t(`parts.${part}`)}
              />
              <Label htmlFor={id} className="text-xs font-normal">
                {t(`parts.${part}`)}
              </Label>
            </div>
          )
        })}
      </div>
      {anyPart && (
        <div className="rounded-md border bg-background p-2">
          <TriggerPolicyEditor
            idPrefix="agent-platform-trigger"
            value={toTriggerPolicyDraft(effective)}
            onChange={(draft) => emitTrigger(fromTriggerPolicyDraft(draft), currentParts)}
            sections={currentParts}
          />
        </div>
      )}
    </div>
  )
}
