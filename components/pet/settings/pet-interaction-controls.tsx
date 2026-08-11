"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  ModelOverrideFields,
  useUtilityProviderOptions,
} from "@/components/settings/common/model-override-fields"
import { clearPetConversation } from "@/lib/db/pet-conversation"
import {
  DEFAULT_PET_PROACTIVE,
  type PetProactiveSettings,
  type PetProactiveTier,
} from "@/types/pet"
import type { UtilityModelConfig } from "@cognia/agent-config-types"

import type { PetControlsProps } from "./pet-appearance-controls"

const PROACTIVE_TIERS: PetProactiveTier[] = ["quiet", "normal", "chatty"]
const MAX_CUSTOM_BUBBLES = 12
const MAX_BUBBLE_LEN = 60

export function PetInteractionControls({ pet, patch }: PetControlsProps) {
  const t = useTranslations("settings.pet")
  const [draft, setDraft] = useState("")
  const phrases = pet.customBubbles ?? []
  const providers = useUtilityProviderOptions()
  const proactive: PetProactiveSettings = pet.proactive ?? DEFAULT_PET_PROACTIVE

  const addPhrase = () => {
    const text = draft.trim()
    if (!text || phrases.length >= MAX_CUSTOM_BUBBLES) return
    patch({ customBubbles: [...phrases, text.slice(0, MAX_BUBBLE_LEN)] })
    setDraft("")
  }
  const patchLlmSpeak = (next: Partial<UtilityModelConfig>) =>
    patch({ llmSpeak: { ...pet.llmSpeak, ...next } })
  const patchProactive = (next: Partial<PetProactiveSettings>) =>
    patch({ proactive: { ...proactive, ...next } })

  return (
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-muted">{t("mutedBubbles.label")}</FieldLabel>
          <FieldDescription>{t("mutedBubbles.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-muted"
          checked={pet.mutedBubbles}
          onCheckedChange={(mutedBubbles) => patch({ mutedBubbles })}
        />
      </Field>

      <Field>
        <FieldContent>
          <FieldLabel htmlFor="pet-custom-bubble">{t("customBubbles.label")}</FieldLabel>
          <FieldDescription>{t("customBubbles.description")}</FieldDescription>
        </FieldContent>
        {phrases.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" data-testid="pet-custom-bubbles">
            {phrases.map((phrase, index) => (
              <Badge key={`${phrase}-${index}`} variant="outline" className="gap-1 font-normal">
                {phrase}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("customBubbles.remove", { phrase })}
                  onClick={() =>
                    patch({ customBubbles: phrases.filter((_, itemIndex) => itemIndex !== index) })
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              </Badge>
            ))}
          </div>
        ) : null}
        <InputGroup>
          <InputGroupInput
            id="pet-custom-bubble"
            value={draft}
            placeholder={t("customBubbles.placeholder")}
            aria-label={t("customBubbles.label")}
            maxLength={MAX_BUBBLE_LEN}
            disabled={phrases.length >= MAX_CUSTOM_BUBBLES}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addPhrase()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("customBubbles.add")}
              disabled={!draft.trim() || phrases.length >= MAX_CUSTOM_BUBBLES}
              onClick={addPhrase}
            >
              <PlusIcon className="size-4" />
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pet-llm-speak">{t("llmSpeak.label")}</FieldLabel>
          <FieldDescription>{t("llmSpeak.description")}</FieldDescription>
        </FieldContent>
        <Switch
          id="pet-llm-speak"
          checked={Boolean(pet.llmSpeak?.enabled)}
          onCheckedChange={(enabled) => patchLlmSpeak({ enabled })}
        />
      </Field>

      {pet.llmSpeak?.enabled ? (
        <Field>
          <FieldDescription>{t("llmSpeak.modelHint")}</FieldDescription>
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
        </Field>
      ) : null}

      {pet.llmSpeak?.enabled ? (
        <>
          <FieldSeparator>{t("proactive.title")}</FieldSeparator>
          <Field>
            <FieldTitle>{t("proactive.title")}</FieldTitle>
            <FieldDescription>{t("proactive.description")}</FieldDescription>
          </Field>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="pet-proactive-enabled">
                {t("proactive.enabled.label")}
              </FieldLabel>
              <FieldDescription>{t("proactive.enabled.description")}</FieldDescription>
            </FieldContent>
            <Switch
              id="pet-proactive-enabled"
              checked={proactive.enabled}
              onCheckedChange={(enabled) => patchProactive({ enabled })}
            />
          </Field>

          {proactive.enabled ? (
            <>
              <Field orientation="responsive">
                <FieldTitle id="pet-proactive-tier-label">{t("proactive.tier.label")}</FieldTitle>
                <ToggleGroup
                  id="pet-proactive-tier"
                  type="single"
                  value={proactive.tier}
                  variant="outline"
                  size="sm"
                  aria-labelledby="pet-proactive-tier-label"
                  onValueChange={(tier) =>
                    tier && patchProactive({ tier: tier as PetProactiveTier })
                  }
                >
                  {PROACTIVE_TIERS.map((tier) => (
                    <ToggleGroupItem key={tier} value={tier}>
                      {t(`proactive.tier.options.${tier}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>

              {(
                [
                  ["eventComments", "pet-proactive-events"],
                  ["idleChatter", "pet-proactive-idle"],
                  ["timeGreetings", "pet-proactive-greetings"],
                ] as const
              ).map(([key, id]) => (
                <Field key={key} orientation="responsive">
                  <FieldContent>
                    <FieldLabel htmlFor={id}>{t(`proactive.${key}.label`)}</FieldLabel>
                    <FieldDescription>{t(`proactive.${key}.description`)}</FieldDescription>
                  </FieldContent>
                  <Switch
                    id={id}
                    checked={proactive[key]}
                    onCheckedChange={(value) => patchProactive({ [key]: value })}
                  />
                </Field>
              ))}
            </>
          ) : null}

          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="pet-memory-enabled">{t("memory.label")}</FieldLabel>
              <FieldDescription>{t("memory.description")}</FieldDescription>
            </FieldContent>
            <Switch
              id="pet-memory-enabled"
              checked={pet.petMemory?.enabled !== false}
              onCheckedChange={(enabled) => patch({ petMemory: { enabled } })}
            />
          </Field>
          <Field orientation="responsive">
            <FieldDescription>{t("memory.clearDescription")}</FieldDescription>
            <Button variant="outline" size="sm" onClick={() => void clearPetConversation()}>
              {t("memory.clearAction")}
            </Button>
          </Field>
        </>
      ) : null}
    </FieldGroup>
  )
}
