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
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { usePet } from "@/hooks/pet/use-pet"
import { listPetInventory, patchPetProfile } from "@/lib/db/pet"
import { PALETTE_PRESETS, matchPalettePreset } from "@/lib/pet/bones/palettes"
import { petHatItem } from "@/lib/pet/economy/item-catalog"
import type { PetBodyType, PetCosmeticOverride, PetEyes, PetHat } from "@/types/pet"
import { PetRenderer } from "../pet-renderer"

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

export interface PetCosmeticControlsProps {
  /** Effective skin for the live preview avatar. */
  skinId?: string
}

export function PetCosmeticControls({ skinId }: PetCosmeticControlsProps) {
  const t = useTranslations("pet.customize.cosmetic")
  const { profile, view } = usePet()
  const inventory = useLiveQuery(() => listPetInventory(), [])

  if (!profile || !view) return null
  if (!profile.soul) {
    return <p className="text-sm text-muted-foreground">{t("hatchFirst")}</p>
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
    <div className="flex flex-col gap-4 sm:flex-row" data-testid="pet-cosmetic-controls">
      <div className="flex items-center justify-center rounded-xl border bg-muted/30 p-4 sm:w-44">
        <PetRenderer
          bones={view.effectiveBones}
          stage={profile.stage}
          state="idle"
          size={120}
          skinId={skinId}
        />
      </div>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-2">
          <Label>{t("palette")}</Label>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("palette")}>
            <button
              type="button"
              aria-label={t("default")}
              aria-pressed={!cosmetic.palette}
              onClick={() => set({ palette: undefined })}
              className={cn(
                "size-8 rounded-full border-2 bg-background text-xs text-muted-foreground",
                !cosmetic.palette ? "border-primary" : "border-transparent"
              )}
            >
              ✕
            </button>
            {PALETTE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-label={t(`paletteOptions.${p.id}`)}
                aria-pressed={activePalette === p.id}
                data-palette={p.id}
                onClick={() => set({ palette: p.palette })}
                style={{ background: p.palette.primary }}
                className={cn(
                  "size-8 rounded-full border-2",
                  activePalette === p.id ? "border-primary" : "border-transparent"
                )}
              />
            ))}
          </div>
        </div>

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
        <CosmeticSelect
          id="pet-cosmetic-body"
          label={t("bodyType")}
          defaultLabel={t("default")}
          value={cosmetic.bodyType ?? ""}
          options={BODIES.map((b) => ({ value: b, label: t(`bodyOptions.${b}`) }))}
          onChange={(v) => set({ bodyType: (v || undefined) as PetBodyType | undefined })}
        />

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
      </div>
    </div>
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
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{defaultLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
