"use client"

/**
 * Execution options for the Mini-Apps hub composer: which agent (character)
 * builds the app, and on which provider/model.
 *
 * Both controls are bindings of existing components, not new ones:
 *  - the agent chip opens `<CharacterPicker>` — the same searchable, built-in /
 *    per-plugin / user-grouped picker the chat "new conversation" flow uses;
 *  - the model chip IS `<ModelSelect>`, the control extracted out of the chat
 *    composer's model picker.
 *
 * The difference from chat is only where the choice lands: chat persists onto a
 * `ChatSession` row, this keeps an A2UI-local preference
 * (`lib/a2ui/generation-preferences.ts`) that `generateA2UIApp` folds onto its
 * throwaway session. An unset field is not a placeholder — it falls through to
 * the same app default `resolveSendOptions` would have picked anyway.
 */

import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { CharacterPicker } from "@/components/chat/character-picker"
import { ModelSelect, composerChipTriggerClass } from "@/components/shared/model-select"
import { useCharacters } from "@/lib/data-hooks/context"
import { useSettingsStore } from "@/stores/settings"
import { cn } from "@/lib/utils"
import type { A2UIGenerationPreferences } from "@/lib/a2ui/generation-preferences"

export interface A2UIGenerationOptionsProps {
  value: A2UIGenerationPreferences
  onChange: (next: A2UIGenerationPreferences) => void
  disabled?: boolean
  className?: string
}

export function A2UIGenerationOptions({
  value,
  onChange,
  disabled,
  className,
}: A2UIGenerationOptionsProps) {
  const t = useTranslations("a2ui")
  const characters = useCharacters() ?? []
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const [pickerOpen, setPickerOpen] = useState(false)

  // A preference pointing at a character that has since been deleted must not
  // pin a ghost: an unresolvable id reads as "default agent", which is also
  // what the send path does with it.
  const selected = value.characterId
    ? (characters.find((character) => character.id === value.characterId) ?? null)
    : null

  // Same fallback chain the chat picker shows, so an untouched hub composer
  // displays the model the turn will actually run on rather than "unset".
  const activeModel = value.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
  const activeProvider = value.provider ?? defaultProvider ?? "anthropic"

  return (
    <div
      role="group"
      aria-label={t("generationOptions")}
      data-testid="a2ui-generation-options"
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={t("pickAgent")}
            data-testid="a2ui-agent-chip"
            className={composerChipTriggerClass}
            onClick={() => setPickerOpen(true)}
          >
            {selected ? (
              <AvatarBadge
                subject={{ ...selected, avatarImageUrl: selected.avatarImage?.webDataUrl }}
                size={14}
                textClassName="text-[8px]"
                className="shrink-0"
              />
            ) : (
              <BotIcon className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{selected?.name ?? t("defaultAgent")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("pickAgent")}</TooltipContent>
      </Tooltip>

      {selected ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={t("clearAgent")}
          data-testid="a2ui-agent-clear"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onChange({ ...value, characterId: undefined })}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}

      {/* No Auto row here on purpose: chat's Auto entry also flips the global
          `autoRouting.enabled` setting, and a hub composer must not reach into
          a shared setting. Leaving the model unset already inherits whatever
          the app default is — including Auto, when the user enabled it. */}
      <ModelSelect
        model={activeModel}
        provider={activeProvider}
        onSelect={({ providerId, modelId }) =>
          onChange({ ...value, model: modelId, provider: providerId })
        }
        disabled={disabled}
        side="bottom"
        align="start"
      />

      <CharacterPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(character) => onChange({ ...value, characterId: character.id })}
      />
    </div>
  )
}
