// Interaction + speech controls: muted bubbles, opt-in LLM speak (with model
// override), proactive speech, and conversation memory. Presentational over the
// shared `{ pet, patch }` interface.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { clearPetConversation } from "@/lib/db/pet-conversation"
import {
  DEFAULT_PET_PROACTIVE,
  type PetProactiveSettings,
  type PetProactiveTier,
} from "@/types/pet"
import {
  ModelOverrideFields,
  useUtilityProviderOptions,
} from "@/components/settings/common/model-override-fields"
import type { UtilityModelConfig } from "@cognia/agent-config-types"
import type { PetControlsProps } from "./pet-appearance-controls"

const PROACTIVE_TIERS: PetProactiveTier[] = ["quiet", "normal", "chatty"]
const MAX_CUSTOM_BUBBLES = 12
const MAX_BUBBLE_LEN = 60

export function PetInteractionControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const [draft, setDraft] = useState("")

  const phrases = pet.customBubbles ?? []
  const addPhrase = () => {
    const text = draft.trim()
    if (!text || phrases.length >= MAX_CUSTOM_BUBBLES) return
    patch({ customBubbles: [...phrases, text.slice(0, MAX_BUBBLE_LEN)] })
    setDraft("")
  }
  const removePhrase = (idx: number) =>
    patch({ customBubbles: phrases.filter((_, i) => i !== idx) })

  const providers = useUtilityProviderOptions()
  const patchLlmSpeak = (next: Partial<UtilityModelConfig>) =>
    patch({ llmSpeak: { ...pet.llmSpeak, ...next } })

  const proactive: PetProactiveSettings = pet.proactive ?? DEFAULT_PET_PROACTIVE
  const patchProactive = (next: Partial<PetProactiveSettings>) =>
    patch({ proactive: { ...proactive, ...next } })

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-muted">{t("mutedBubbles.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("mutedBubbles.description")}</p>
        </div>
        <Switch
          id="pet-muted"
          checked={pet.mutedBubbles}
          onCheckedChange={(v) => patch({ mutedBubbles: v })}
        />
      </div>

      {/* User catchphrases mixed into the template bubble pool. */}
      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label htmlFor="pet-custom-bubble">{t("customBubbles.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("customBubbles.description")}</p>
        </div>
        {phrases.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="pet-custom-bubbles">
            {phrases.map((phrase, i) => (
              <Badge
                key={`${phrase}-${i}`}
                variant="outline"
                className="gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-normal"
              >
                {phrase}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("customBubbles.remove", { phrase })}
                  className="size-5 rounded-full p-0.5 text-muted-foreground"
                  onClick={() => removePhrase(i)}
                >
                  <XIcon className="size-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            id="pet-custom-bubble"
            value={draft}
            placeholder={t("customBubbles.placeholder")}
            aria-label={t("customBubbles.label")}
            maxLength={MAX_BUBBLE_LEN}
            disabled={phrases.length >= MAX_CUSTOM_BUBBLES}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addPhrase()
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label={t("customBubbles.add")}
            disabled={!draft.trim() || phrases.length >= MAX_CUSTOM_BUBBLES}
            onClick={addPhrase}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Opt-in LLM speak for the talk interaction (off = template bubbles only). */}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="pet-llm-speak">{t("llmSpeak.label")}</Label>
          <p className="text-sm text-muted-foreground">{t("llmSpeak.description")}</p>
        </div>
        <Switch
          id="pet-llm-speak"
          checked={!!pet.llmSpeak?.enabled}
          onCheckedChange={(v) => patchLlmSpeak({ enabled: v })}
        />
      </div>
      {!!pet.llmSpeak?.enabled && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs text-muted-foreground">{t("llmSpeak.modelHint")}</p>
          <ModelOverrideFields
            value={pet.llmSpeak}
            providers={providers}
            onChange={patchLlmSpeak}
            labels={{
              provider: t("llmSpeak.provider"),
              model: t("llmSpeak.model"),
              useDefault: t("llmSpeak.useDefault"),
            }}
          />
        </div>
      )}

      {/* Proactive speech + conversation memory ride the same LLM side channel. */}
      {!!pet.llmSpeak?.enabled && (
        <div className="space-y-4 border-t pt-4">
          <div className="space-y-0.5">
            <Label>{t("proactive.title")}</Label>
            <p className="text-sm text-muted-foreground">{t("proactive.description")}</p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pet-proactive-enabled">{t("proactive.enabled.label")}</Label>
              <p className="text-sm text-muted-foreground">{t("proactive.enabled.description")}</p>
            </div>
            <Switch
              id="pet-proactive-enabled"
              checked={proactive.enabled}
              onCheckedChange={(v) => patchProactive({ enabled: v })}
            />
          </div>

          {proactive.enabled && (
            <>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="pet-proactive-tier">{t("proactive.tier.label")}</Label>
                <NativeSelect
                  id="pet-proactive-tier"
                  size="sm"
                  value={proactive.tier}
                  onChange={(e) => patchProactive({ tier: e.target.value as PetProactiveTier })}
                >
                  {PROACTIVE_TIERS.map((tier) => (
                    <NativeSelectOption key={tier} value={tier}>
                      {t(`proactive.tier.options.${tier}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="pet-proactive-events">{t("proactive.eventComments.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("proactive.eventComments.description")}
                  </p>
                </div>
                <Switch
                  id="pet-proactive-events"
                  checked={proactive.eventComments}
                  onCheckedChange={(v) => patchProactive({ eventComments: v })}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="pet-proactive-idle">{t("proactive.idleChatter.label")}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t("proactive.idleChatter.description")}
                  </p>
                </div>
                <Switch
                  id="pet-proactive-idle"
                  checked={proactive.idleChatter}
                  onCheckedChange={(v) => patchProactive({ idleChatter: v })}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="pet-proactive-greetings">
                    {t("proactive.timeGreetings.label")}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("proactive.timeGreetings.description")}
                  </p>
                </div>
                <Switch
                  id="pet-proactive-greetings"
                  checked={proactive.timeGreetings}
                  onCheckedChange={(v) => patchProactive({ timeGreetings: v })}
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="pet-memory-enabled">{t("memory.label")}</Label>
              <p className="text-sm text-muted-foreground">{t("memory.description")}</p>
            </div>
            <Switch
              id="pet-memory-enabled"
              checked={pet.petMemory?.enabled !== false}
              onCheckedChange={(v) => patch({ petMemory: { enabled: v } })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">{t("memory.clearDescription")}</p>
            <Button variant="outline" size="sm" onClick={() => void clearPetConversation()}>
              {t("memory.clearAction")}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
