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
import type { PetNeedKind, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { PetStatCard } from "./pet-stat-card"

function NeedBar({ kind, value, label }: { kind: PetNeedKind; value: number; label: string }) {
  return (
    <div data-need={kind} className="grid grid-cols-[4rem_1fr_2.5rem] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            value < 25 ? "bg-destructive" : value < 50 ? "bg-amber-400" : "bg-primary"
          )}
          style={{ width: `${Math.round(value)}%` }}
        />
      </div>
      <span className="text-right text-xs tabular-nums">{Math.round(value)}</span>
    </div>
  )
}

export interface PetInteractionPanelProps {
  profile: PetProfile
  view: PetView
  onFeed: () => void
  onPlay: () => void
  onPet: () => void
  /** Talk action. Submitted composer text rides along; bare click omits it. */
  onTalk: (text?: string) => void
  className?: string
}

export function PetInteractionPanel({
  profile,
  view,
  onFeed,
  onPlay,
  onPet,
  onTalk,
  className,
}: PetInteractionPanelProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(profile.xp)
  const [talkOpen, setTalkOpen] = useState(false)
  const [talkText, setTalkText] = useState("")

  const submitTalk = () => {
    const text = talkText.trim()
    onTalk(text || undefined)
    setTalkText("")
  }

  return (
    <div data-testid="pet-interaction-panel" className={cn("flex w-72 flex-col gap-3", className)}>
      <PetStatCard bones={view.effectiveBones} soul={profile.soul} stage={profile.stage} />

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
            onChange={(e) => setTalkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTalk()
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
