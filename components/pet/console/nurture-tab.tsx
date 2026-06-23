// The `/pet` console nurture tab: a wide, responsive home for the hatched pet.
// Reuses the shared `PetStatCard` + `NeedBar` and lays out a hero preview beside
// the stats / needs / level / interaction controls. On large screens it splits
// into two columns; on small screens it stacks (hero first). The interaction
// buttons gate spamming with a per-action cooldown (`useActionCooldown`).

"use client"

import { useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  CookieIcon,
  Gamepad2Icon,
  HeartIcon,
  MessageCircleIcon,
  MoonIcon,
  DropletsIcon,
  GiftIcon,
  SendIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { levelProgress } from "@/lib/pet/xp/leveling"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import { usePetStore } from "@/stores/pet/pet-store"
import { useActionCooldown } from "@/hooks/pet/use-action-cooldown"
import { PetStatCard } from "../pet-stat-card"
import { NeedBar } from "../need-bar"
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
}

interface ActionDef {
  kind: string
  labelKey: string
  Icon: ComponentType<{ className?: string }>
  run: () => void
  cooldownMs: number
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
}: NurtureTabProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(profile.xp)
  const grewStats = usePetStore((s) => s.lastGrewStats)
  const { remaining, trigger } = useActionCooldown()
  const [talkOpen, setTalkOpen] = useState(false)
  const [talkText, setTalkText] = useState("")

  const submitTalk = () => {
    const text = talkText.trim()
    onTalk(text || undefined)
    setTalkText("")
  }

  // `kind` matches the emitted PetEvent kind so the cooldown is keyed identically.
  const actions: ActionDef[] = [
    { kind: "fed", labelKey: "actions.feed", Icon: CookieIcon, run: onFeed, cooldownMs: 1500 },
    { kind: "played", labelKey: "actions.play", Icon: Gamepad2Icon, run: onPlay, cooldownMs: 1500 },
    { kind: "petted", labelKey: "actions.pet", Icon: HeartIcon, run: onPet, cooldownMs: 1500 },
    { kind: "slept", labelKey: "actions.sleep", Icon: MoonIcon, run: onSleep, cooldownMs: 5000 },
    {
      kind: "cleaned",
      labelKey: "actions.clean",
      Icon: DropletsIcon,
      run: onClean,
      cooldownMs: 4000,
    },
    { kind: "treated", labelKey: "actions.treat", Icon: GiftIcon, run: onTreat, cooldownMs: 10000 },
  ]

  return (
    <div
      data-testid="pet-nurture-tab"
      className="mx-auto grid w-full max-w-4xl gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
    >
      {/* Main column: stats, level, needs, actions. */}
      <div className="flex flex-col gap-4">
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
            <span className="tabular-nums text-muted-foreground">
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
          {actions.map((a) => {
            const rem = remaining(a.kind)
            const cooling = rem > 0
            return (
              <Button
                key={a.kind}
                variant="secondary"
                disabled={cooling}
                data-action={a.kind}
                aria-label={t(a.labelKey)}
                onClick={() => {
                  a.run()
                  trigger(a.kind, a.cooldownMs)
                }}
              >
                {cooling ? (
                  <span className="text-xs tabular-nums">{Math.ceil(rem / 1000)}</span>
                ) : (
                  <a.Icon className="size-4" />
                )}
              </Button>
            )
          })}
          <Button
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
              className="h-9 text-sm"
              maxLength={500}
              onChange={(e) => setTalkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitTalk()
              }}
            />
            <Button className="shrink-0" onClick={submitTalk} aria-label={t("talkInput.send")}>
              <SendIcon className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Hero column: a large live preview of the pet. */}
      <aside
        className={cn(
          "order-first flex items-center justify-center rounded-xl border bg-card p-6 lg:order-none lg:items-start"
        )}
      >
        <PetRenderer
          bones={view.effectiveBones}
          stage={profile.stage}
          state="idle"
          size={160}
          skinId={skinId}
        />
      </aside>
    </div>
  )
}
