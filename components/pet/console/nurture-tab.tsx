// The `/pet` console nurture tab: a wide, responsive home for the hatched pet.
// Reuses the shared `PetStatCard`, `PetVitalsCard`, `PetActionGrid`, and
// `PetTalkComposer` and lays out a hero preview beside them. On large screens
// it splits into two columns; on small screens it stacks (hero first). Because
// the grid/composer are the same components the popup uses, this tab shares
// their cooldown gate, IME-safe Enter, and ↑/↓ phrase recall.

"use client"

import { useState } from "react"
import type { PetProfile, PetSkinSelection } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import { PetStatCard } from "../pet-stat-card"
import { PetVitalsCard } from "../pet-vitals-card"
import { PetWalletStrip } from "../pet-wallet-strip"
import { PetActionGrid } from "../pet-action-grid"
import { PetInventoryStrip } from "../pet-inventory-strip"
import { PetTalkComposer } from "../pet-talk-composer"
import { PetRenderer } from "../pet-renderer"
import { Separator } from "@/components/ui/separator"

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
}: NurtureTabProps) {
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const [talkOpen, setTalkOpen] = useState(false)

  return (
    <div
      data-testid="pet-nurture-tab"
      className="mx-auto grid w-full max-w-5xl gap-5 @3xl/pet-pane:grid-cols-[minmax(0,1fr)_18rem]"
    >
      {/* Main column: stats, level + needs, actions. */}
      <div className="flex min-w-0 flex-col gap-5">
        <PetStatCard
          bones={view.effectiveBones}
          soul={profile.soul}
          stage={profile.stage}
          progress={profile.statProgress}
          grew={grewStats}
          flavor={profile.evolutionFlavor}
          skinId={skinId}
          selection={selection}
          variant="flat"
        />

        <Separator />

        <PetWalletStrip
          coins={profile.coins}
          streak={profile.streak}
          onOpenShop={onOpenShop}
          variant="flat"
        />

        <Separator />

        <PetVitalsCard
          xp={profile.xp}
          needs={view.needs}
          mood={view.mood}
          condition={view.condition}
          variant="flat"
        />

        <Separator />

        <PetActionGrid
          onFeed={onFeed}
          onPlay={onPlay}
          onPet={onPet}
          onSleep={onSleep}
          onClean={onClean}
          onTreat={onTreat}
          talkOpen={talkOpen}
          onToggleTalk={() => setTalkOpen((o) => !o)}
        />

        <PetInventoryStrip variant="flat" />

        {talkOpen && <PetTalkComposer onTalk={onTalk} />}
      </div>

      {/* Hero column: a large live preview of the pet. */}
      <aside className="order-first flex items-center justify-center border-b pb-5 @3xl/pet-pane:order-none @3xl/pet-pane:items-start @3xl/pet-pane:border-b-0 @3xl/pet-pane:border-l @3xl/pet-pane:pb-0 @3xl/pet-pane:pl-5">
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
      </aside>
    </div>
  )
}
