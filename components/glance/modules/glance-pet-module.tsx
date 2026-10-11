"use client"

/**
 * Pet module: mood and needs, with the tray menu's quick care commands
 * (ADR-0225 §2). Care runs in place and keeps the panel open; the pet page is
 * one click away for everything else.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import type { GlancePetCommand } from "@/lib/glance/requests"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { useGlance } from "../glance-context"
import {
  GlanceCompactSection,
  GlanceLinkButton,
  GlanceMeter,
  GlanceSection,
} from "../glance-primitives"

const CARE: ReadonlyArray<{ command: GlancePetCommand; key: string }> = [
  { command: "pet.feed", key: "feed" },
  { command: "pet.play", key: "play" },
  { command: "pet.sleep", key: "sleep" },
]

export function GlancePetModule({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("glance.modules.pet")
  const { snapshot, send, route } = useGlance()
  const pet = snapshot.pet
  const [pending, setPending] = useState<GlancePetCommand | null>(null)
  const [failed, setFailed] = useState(false)
  const title = t("label")
  const openPet = () => route({ kind: "open-owner", owner: "pet" })

  if (!pet || !pet.enabled) {
    return (
      <GlanceCompactSection moduleId="pet" title={title} label={t("open")} onClick={openPet}>
        <span className="text-muted-foreground">{pet ? t("disabled") : t("loading")}</span>
      </GlanceCompactSection>
    )
  }

  const mood = pet.mood ? t(`mood.${pet.mood}`) : ""
  const condition = pet.condition === "unwell" ? t("unwell") : null

  if (size === "compact") {
    return (
      <GlanceCompactSection moduleId="pet" title={title} label={t("open")} onClick={openPet}>
        <span className="truncate">{condition ?? mood}</span>
        <span className="truncate text-[11.5px] text-muted-foreground">
          {t("needsShort", { mood: pet.moodLevel, energy: pet.energy })}
        </span>
      </GlanceCompactSection>
    )
  }

  const meter = (label: string, value: number) => (
    <div className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2 py-px text-[11.5px] text-muted-foreground">
      <span>{label}</span>
      <GlanceMeter pct={value} severity={value < 30 ? "warn" : "ok"} label={label} />
      <span className="text-right tabular-nums text-foreground">{value}%</span>
    </div>
  )

  const care = async (command: GlancePetCommand) => {
    setPending(command)
    setFailed(false)
    const errorKey = await send({ kind: "pet-care", command })
    setPending(null)
    if (errorKey) setFailed(true)
  }

  return (
    <GlanceSection
      moduleId="pet"
      title={title}
      meta={
        <span className="truncate text-[11px] text-muted-foreground/80">{condition ?? mood}</span>
      }
      aside={<GlanceLinkButton onClick={openPet}>{t("open")}</GlanceLinkButton>}
    >
      {meter(t("needs.mood"), pet.moodLevel)}
      {meter(t("needs.energy"), pet.energy)}
      {meter(t("needs.bond"), pet.bond)}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {CARE.map(({ command, key }) => (
          <Button
            key={command}
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[11.5px]"
            disabled={pending !== null}
            onClick={() => void care(command)}
          >
            {t(`care.${key}`)}
          </Button>
        ))}
      </div>
      {failed ? <p className="mt-1 text-[11.5px] text-destructive">{t("careFailed")}</p> : null}
    </GlanceSection>
  )
}
