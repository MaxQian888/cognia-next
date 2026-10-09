// The `/pet` console nurture tab: a wide, responsive home for the hatched pet.
//
// Two columns once the pane is wide enough. The left one is the pet as it is
// right now (hero preview, mood and condition with how to recover, level and
// needs) and sticks while the right one scrolls; the right one is what you can
// do (care actions at a touch-friendly size, quick-use items, the wallet and
// streak, the talk composer) followed by the pet's identity and stats. On a
// narrow pane they stack, pet first. Flat sections with headings and
// separators, no cards: the console is already a page.
//
// Reuses the shared `PetStatCard`, `PetVitalsCard`, `PetActionGrid`,
// `PetInventoryStrip` and `PetTalkComposer`, so this tab shares the popup's
// cooldown gate, IME-safe Enter and ↑/↓ phrase recall. Every action arrives as
// a prop: the console decides what feeding the pet runs.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { PetProfile, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import { Separator } from "@/components/ui/separator"
import { PetStatCard } from "../pet-stat-card"
import { PetVitalsCard } from "../pet-vitals-card"
import { PetWalletStrip } from "../pet-wallet-strip"
import { PetActionGrid } from "../pet-action-grid"
import { PetInventoryStrip } from "../pet-inventory-strip"
import { PetTalkComposer } from "../pet-talk-composer"
import { PetRenderer } from "../pet-renderer"

export interface NurtureTabProps {
  profile: PetProfile
  view: PetView
  onFeed: () => void
  onPlay: () => void
  onPet: () => void
  /** Talk action. Submitted composer text rides along; bare click omits it. */
  onTalk: (text?: string) => void
  onSleep: () => void
  onClean: () => void
  onTreat: () => void
  /** Effective skin so the previews match the live pet. */
  skinId?: string
  selection?: PetSkinSelection
  lowPower?: boolean
  /** Jump to the console's shop tab (wallet strip click). */
  onOpenShop?: () => void
  /** Remaining cooldown per care kind when the caller owns it (remote care). */
  cooldownRemaining?: (kind: string) => number
  /**
   * `composer` opens the talk composer, whose words reach the pet's LLM speak.
   * `direct` makes talk a plain care action: remote care (ADR-0219) carries
   * conversation through the chat tab, which records the turn, so a composer
   * here would collect words the desktop never sees.
   */
  talkMode?: "composer" | "direct"
}

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  )
}

export function NurtureTab({
  profile,
  view,
  onFeed,
  onPlay,
  onPet,
  onTalk,
  onSleep,
  onClean,
  onTreat,
  skinId,
  selection,
  lowPower,
  onOpenShop,
  cooldownRemaining,
  talkMode = "composer",
}: NurtureTabProps) {
  const t = useTranslations("pet")
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const [talkOpen, setTalkOpen] = useState(false)

  return (
    <div
      data-testid="pet-nurture-tab"
      className="mx-auto grid w-full max-w-5xl gap-6 @3xl/pet-pane:grid-cols-[18rem_minmax(0,1fr)] @3xl/pet-pane:items-start"
    >
      {/* The pet as it is now. Sticky beside the actions on a wide pane. */}
      <section
        data-testid="pet-nurture-status"
        aria-labelledby="pet-nurture-status-heading"
        className="flex min-w-0 flex-col gap-4 @3xl/pet-pane:sticky @3xl/pet-pane:top-0"
      >
        <h2 id="pet-nurture-status-heading" className="sr-only">
          {t("console.nurture.status")}
        </h2>
        <div className="flex justify-center">
          <PetRenderer
            bones={view.effectiveBones}
            stage={profile.stage}
            state="idle"
            size={160}
            skinId={skinId}
            selection={selection}
            flavor={profile.evolutionFlavor}
            mood={view.mood}
            lowPower={lowPower}
            renderPriority="console"
          />
        </div>
        <PetVitalsCard
          xp={profile.xp}
          needs={view.needs}
          mood={view.mood}
          condition={view.condition}
          variant="flat"
          recoveryHint
        />
      </section>

      <div className="flex min-w-0 flex-col gap-5">
        <section aria-labelledby="pet-nurture-care-heading" className="flex flex-col gap-3">
          <SectionHeading id="pet-nurture-care-heading">{t("console.nurture.care")}</SectionHeading>
          <PetActionGrid
            size="comfortable"
            onFeed={onFeed}
            onPlay={onPlay}
            onPet={onPet}
            onSleep={onSleep}
            onClean={onClean}
            onTreat={onTreat}
            talkOpen={talkMode === "composer" && talkOpen}
            onToggleTalk={() => (talkMode === "direct" ? onTalk() : setTalkOpen((o) => !o))}
            cooldownRemaining={cooldownRemaining}
          />
          {talkMode === "composer" && talkOpen && <PetTalkComposer onTalk={onTalk} />}
          <PetInventoryStrip variant="flat" size="comfortable" />
        </section>

        <Separator />

        <section aria-labelledby="pet-nurture-wallet-heading" className="flex flex-col gap-2">
          <SectionHeading id="pet-nurture-wallet-heading">
            {t("console.nurture.wallet")}
          </SectionHeading>
          <PetWalletStrip
            coins={profile.coins}
            streak={profile.streak}
            onOpenShop={onOpenShop}
            variant="flat"
            className="min-h-11"
          />
        </section>

        <Separator />

        <section aria-labelledby="pet-nurture-stats-heading" className="flex flex-col gap-3">
          <SectionHeading id="pet-nurture-stats-heading">
            {t("console.nurture.stats")}
          </SectionHeading>
          <PetStatCard
            bones={view.effectiveBones}
            soul={profile.soul}
            stage={profile.stage}
            progress={profile.statProgress}
            grew={grewStats}
            flavor={profile.evolutionFlavor}
            skinId={skinId}
            selection={selection}
            lowPower={lowPower}
            variant="flat"
          />
        </section>
      </div>
    </div>
  )
}
