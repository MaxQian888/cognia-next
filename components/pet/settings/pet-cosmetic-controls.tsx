// In-app "Look" editor: restyle the pet's palette / hat / eyes / body without
// touching its identity (species, rarity, stars, shiny, stats stay genetic).
// Persists to `profile.cosmetic` via `patchPetProfile`; the live preview reads
// the same reactive profile, so changes show immediately. A "default" choice
// per field clears that override and falls back to genetics.
//
// Premium hats are shop rewards: a hat backed by a decor item stays locked
// until that item is owned (`petInventory`), so decor purchases actually gate
// something. The genetic hat and `none` are always free; genetics-only hats
// (tinyduck) never unlock through the shop.

"use client"

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePet } from "@/hooks/pet/use-pet"
import { listPetInventory, patchPetProfile } from "@/lib/db/pet"
import { PALETTE_PRESETS, matchPalettePreset } from "@/lib/pet/bones/palettes"
import { petHatItem } from "@/lib/pet/economy/item-catalog"
import type { PetBodyType, PetCosmeticOverride, PetEyes, PetHat } from "@/types/pet"

const HATS: PetHat[] = [
  "none",
  "beanie",
  "propeller",
  "tophat",
  "wizard",
  "halo",
  "crown",
  "tinyduck",
]
const EYES: PetEyes[] = ["dot", "sleepy", "wide", "wink", "star", "spiral"]
const BODIES: PetBodyType[] = ["round", "tall", "wide"]

/** Drop empty fields; return undefined when nothing is overridden. */
function cleanCosmetic(next: PetCosmeticOverride): PetCosmeticOverride | undefined {
  const out: PetCosmeticOverride = {}
  if (next.palette) out.palette = next.palette
  if (next.hat) out.hat = next.hat
  if (next.eyes) out.eyes = next.eyes
  if (next.bodyType) out.bodyType = next.bodyType
  return Object.keys(out).length ? out : undefined
}

export function PetCosmeticControls() {
  const t = useTranslations("pet.customize.cosmetic")
  const { profile, view } = usePet()
  const inventory = useLiveQuery(() => listPetInventory(), [])

  if (!profile || !view) return null
  if (!profile.soul) {
    return (
      <Empty className="py-6">
        <EmptyDescription>{t("hatchFirst")}</EmptyDescription>
      </Empty>
    )
  }

  const cosmetic = profile.cosmetic ?? {}
  const set = (next: PetCosmeticOverride) =>
    void patchPetProfile({ cosmetic: cleanCosmetic({ ...cosmetic, ...next }) })
  const activePalette = matchPalettePreset(cosmetic.palette)
  const hasOverride = !!profile.cosmetic && Object.keys(profile.cosmetic).length > 0

  const ownedIds = new Set((inventory ?? []).map((row) => row.id))
  const geneticHat = view.bones.hat
  const hatLocked = (hat: PetHat): boolean => {
    // The genetic hat and bare-headed are always free; a currently applied
    // override stays selectable so a pre-gating profile can never get stuck.
    if (hat === "none" || hat === geneticHat || hat === cosmetic.hat) return false
    const item = petHatItem(hat)
    // Shop-backed hats need their decor item owned; hats with no shop item
    // (tinyduck) are genetics-only and never unlock here.
    return item ? !ownedIds.has(item.id) : true
  }

  return (
    <FieldGroup data-testid="pet-cosmetic-controls">
      <Field>
        <FieldTitle id="pet-cosmetic-palette-label">{t("palette")}</FieldTitle>
        <ToggleGroup
          type="single"
          value={activePalette ?? "default"}
          variant="outline"
          spacing={2}
          aria-labelledby="pet-cosmetic-palette-label"
          className="flex-wrap justify-start"
          onValueChange={(value) => {
            if (value === "default") set({ palette: undefined })
            else {
              const palette = PALETTE_PRESETS.find((preset) => preset.id === value)?.palette
              if (palette) set({ palette })
            }
          }}
        >
          <ToggleGroupItem
            value="default"
            aria-label={t("default")}
            className="size-8 rounded-full p-0"
          >
            ✕
          </ToggleGroupItem>
          {PALETTE_PRESETS.map((p) => (
            <ToggleGroupItem
              key={p.id}
              value={p.id}
              aria-label={t(`paletteOptions.${p.id}`)}
              data-palette={p.id}
              style={{ background: p.palette.primary }}
              className="size-8 rounded-full p-0"
            />
          ))}
        </ToggleGroup>
      </Field>

      <CosmeticSelect
        id="pet-cosmetic-hat"
        label={t("hat")}
        defaultLabel={t("default")}
        value={cosmetic.hat ?? ""}
        options={HATS.map((h) => {
          const locked = hatLocked(h)
          return {
            value: h,
            label: locked
              ? t("lockedOption", { name: t(`hatOptions.${h}`) })
              : t(`hatOptions.${h}`),
            disabled: locked,
          }
        })}
        onChange={(v) => set({ hat: (v || undefined) as PetHat | undefined })}
      />
      <CosmeticSelect
        id="pet-cosmetic-eyes"
        label={t("eyes")}
        defaultLabel={t("default")}
        value={cosmetic.eyes ?? ""}
        options={EYES.map((e) => ({ value: e, label: t(`eyesOptions.${e}`) }))}
        onChange={(v) => set({ eyes: (v || undefined) as PetEyes | undefined })}
      />
      <Field orientation="responsive">
        <FieldTitle id="pet-cosmetic-body-label">{t("bodyType")}</FieldTitle>
        <ToggleGroup
          id="pet-cosmetic-body"
          type="single"
          value={cosmetic.bodyType ?? ""}
          variant="outline"
          size="sm"
          aria-labelledby="pet-cosmetic-body-label"
          onValueChange={(bodyType) =>
            set({ bodyType: (bodyType || undefined) as PetBodyType | undefined })
          }
        >
          <ToggleGroupItem value="">{t("default")}</ToggleGroupItem>
          {BODIES.map((body) => (
            <ToggleGroupItem key={body} value={body}>
              {t(`bodyOptions.${body}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasOverride}
          onClick={() => void patchPetProfile({ cosmetic: undefined })}
        >
          {t("reset")}
        </Button>
      </div>
    </FieldGroup>
  )
}

function CosmeticSelect({
  id,
  label,
  defaultLabel,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  defaultLabel: string
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (value: string) => void
}) {
  return (
    <Field orientation="responsive">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value || "__default__"}
        onValueChange={(next) => onChange(next === "__default__" ? "" : next)}
      >
        <SelectTrigger id={id} size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="__default__">{defaultLabel}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}
