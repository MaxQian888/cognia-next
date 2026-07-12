// The interaction panel shown when the widget is expanded (and inside the pet
// popup window): the stat card, the vitals card (level + needs), and all seven
// care actions (feed/play/pet/talk/sleep/clean/treat). The action grid, the
// vitals card, and the talk composer are shared with the /pet nurture tab —
// this panel only owns the compact w-72 arrangement and the plugin slot.

"use client"

import { useState } from "react"
import { MessagesSquareIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"
import { PetStatCard } from "./pet-stat-card"
import { PetVitalsCard } from "./pet-vitals-card"
import { PetWalletStrip } from "./pet-wallet-strip"
import { PetActionGrid } from "./pet-action-grid"
import { PetInventoryStrip } from "./pet-inventory-strip"
import { PetQuickNav } from "./pet-quick-nav"
import { PetTalkComposer } from "./pet-talk-composer"

export interface PetInteractionPanelProps {
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
  /** Effective skin for the stat-card preview (so it matches the live pet). */
  skinId?: string
  /**
   * Navigate to a /pet console tab. Enables the wallet's shop jump and the
   * quick-nav row; the widget routes in-app, the desktop popup goes over the
   * cross-window bridge. Omit to hide both (no navigation target).
   */
  onOpenConsole?: (tab: PetConsoleTab) => void
  /**
   * Show the owned-consumables quick-use strip. Must be false in the popup
   * window: consuming emits a local pet event and the popup has no controller
   * to process it (the bridge only carries the seven care interactions).
   */
  showInventory?: boolean
  className?: string
}

export function PetInteractionPanel({
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
  onOpenConsole,
  showInventory = true,
  className,
}: PetInteractionPanelProps) {
  const t = useTranslations("pet")
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const [talkOpen, setTalkOpen] = useState(false)

  return (
    <div data-testid="pet-interaction-panel" className={cn("flex w-72 flex-col gap-3", className)}>
      <PetStatCard
        bones={view.effectiveBones}
        soul={profile.soul}
        stage={profile.stage}
        progress={profile.statProgress}
        grew={grewStats}
        flavor={profile.evolutionFlavor}
        skinId={skinId}
      />

      <PetWalletStrip
        coins={profile.coins}
        streak={profile.streak}
        onOpenShop={onOpenConsole ? () => onOpenConsole("shop") : undefined}
      />

      <PetVitalsCard
        xp={profile.xp}
        needs={view.needs}
        mood={view.mood}
        condition={view.condition}
      />

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

      {showInventory && <PetInventoryStrip />}

      <PluginExtensionSlot
        point="pet.panel.actions"
        limit={4}
        className="flex items-center gap-1 empty:hidden"
        context={{
          level: profile.level,
          stage: profile.stage,
          mood: view.mood,
          condition: view.condition,
        }}
      />

      {talkOpen && <PetTalkComposer onTalk={onTalk} />}

      {onOpenConsole && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 justify-start gap-2"
          data-testid="pet-open-chat"
          onClick={() => onOpenConsole("chat")}
        >
          <MessagesSquareIcon className="size-3.5" />
          {t("chat.openPanel")}
        </Button>
      )}

      {onOpenConsole && <PetQuickNav onNavigate={onOpenConsole} />}
    </div>
  )
}
