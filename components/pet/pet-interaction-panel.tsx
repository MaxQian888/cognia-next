// The interaction panel shown when the widget is expanded (and as the /pet
// nurture tab): the stat card, the three need bars, level/XP progress, and the
// feed/play/pet/talk actions.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CookieIcon, Gamepad2Icon, HeartIcon, MessageCircleIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { levelProgress } from "@/lib/pet/xp/leveling"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import { PetStatCard } from "./pet-stat-card"
import { NeedBar } from "./need-bar"

export interface PetInteractionPanelProps {
  profile: PetProfile
  view: PetView
  onFeed: () => void
  onPlay: () => void
  onPet: () => void
  /** Talk action. Submitted composer text rides along; bare click omits it. */
  onTalk: (text?: string) => void
  /** Effective skin for the stat-card preview (so it matches the live pet). */
  skinId?: string
  className?: string
}

export function PetInteractionPanel({
  profile,
  view,
  onFeed,
  onPlay,
  onPet,
  onTalk,
  skinId,
  className,
}: PetInteractionPanelProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(profile.xp)
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const [talkOpen, setTalkOpen] = useState(false)
  const [talkText, setTalkText] = useState("")
  // ↑/↓ recall of previous things said to the pet, persisted globally (one pet
  // talk surface) so phrases can be repeated across sessions.
  const history = useCommandHistory({ persistKey: "cmdhist:pet-talk" })

  const submitTalk = () => {
    const text = talkText.trim()
    history.record(text)
    onTalk(text || undefined)
    setTalkText("")
  }

  return (
    <div data-testid="pet-interaction-panel" className={cn("flex w-72 flex-col gap-3", className)}>
      <PetStatCard
        bones={view.effectiveBones}
        soul={profile.soul}
        stage={profile.stage}
        progress={profile.statProgress}
        grew={grewStats}
        skinId={skinId}
      />

      <div className="rounded-lg border p-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium">{t("panel.level", { level: progress.level })}</span>
          <span className="text-muted-foreground tabular-nums">
            {progress.intoLevel}/{progress.span}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.round(progress.fraction * 100)}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <NeedBar kind="energy" value={view.needs.energy} label={t("needs.energy")} />
        <NeedBar kind="mood" value={view.needs.mood} label={t("needs.mood")} />
        <NeedBar kind="bond" value={view.needs.bond} label={t("needs.bond")} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Button size="sm" variant="secondary" onClick={onFeed} aria-label={t("actions.feed")}>
          <CookieIcon className="size-4" />
        </Button>
        <Button size="sm" variant="secondary" onClick={onPlay} aria-label={t("actions.play")}>
          <Gamepad2Icon className="size-4" />
        </Button>
        <Button size="sm" variant="secondary" onClick={onPet} aria-label={t("actions.pet")}>
          <HeartIcon className="size-4" />
        </Button>
        <Button
          size="sm"
          variant={talkOpen ? "default" : "secondary"}
          onClick={() => setTalkOpen((o) => !o)}
          aria-label={t("actions.talk")}
        >
          <MessageCircleIcon className="size-4" />
        </Button>
      </div>

      {talkOpen && (
        <div className="flex items-center gap-2" data-testid="pet-talk-composer">
          <Input
            value={talkText}
            placeholder={t("talkInput.placeholder")}
            aria-label={t("talkInput.placeholder")}
            className="h-8 text-xs"
            maxLength={500}
            onChange={(e) => {
              setTalkText(e.target.value)
              history.noteEdit()
            }}
            onKeyDown={(e) => {
              if (handleHistoryArrowKey(e, history, setTalkText)) return
              if (e.key === "Enter" && !e.nativeEvent.isComposing) submitTalk()
            }}
          />
          <Button
            size="sm"
            className="h-8 shrink-0"
            onClick={submitTalk}
            aria-label={t("talkInput.send")}
          >
            <SendIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
