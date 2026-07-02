// The interaction panel shown when the widget is expanded (and inside the pet
// popup window): the stat card, the three need bars, level/XP progress, and
// all seven care actions (feed/play/pet/talk/sleep/clean/treat).

"use client"

import { useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  CookieIcon,
  DropletsIcon,
  Gamepad2Icon,
  GiftIcon,
  HeartIcon,
  MessageCircleIcon,
  MoonIcon,
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
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
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
  onSleep: () => void
  onClean: () => void
  onTreat: () => void
  /** Effective skin for the stat-card preview (so it matches the live pet). */
  skinId?: string
  className?: string
}

interface ActionDef {
  kind: string
  labelKey: string
  Icon: ComponentType<{ className?: string }>
  run: () => void
  cooldownMs: number
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
  className,
}: PetInteractionPanelProps) {
  const t = useTranslations("pet")
  const progress = levelProgress(profile.xp)
  const grewStats = usePetStore((s) => s.lastGrewStats)
  // Cooldowns live in the per-window zustand store (UI-only spam gate — the
  // controller processes every event). In the popup window that store is a
  // fresh instance, so cooldowns reset when the popup reopens; acceptable by
  // design, and they must NOT join the persisted {minimized, position} slice.
  const { remaining, trigger } = useActionCooldown()
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

  // `kind` matches the emitted PetEvent kind so the cooldown is keyed
  // identically to the nurture tab's — same key, same gate.
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
        {actions.map((a) => {
          const rem = remaining(a.kind)
          const cooling = rem > 0
          return (
            <Button
              key={a.kind}
              size="sm"
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
          size="sm"
          variant={talkOpen ? "default" : "secondary"}
          onClick={() => setTalkOpen((o) => !o)}
          aria-label={t("actions.talk")}
        >
          <MessageCircleIcon className="size-4" />
        </Button>
      </div>

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
