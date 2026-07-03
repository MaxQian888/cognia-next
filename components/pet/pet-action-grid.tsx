// The shared care-action grid (feed/play/pet/sleep/clean/treat + the talk
// toggle) used by both the compact interaction panel (widget/popup) and the
// wide `/pet` nurture tab — one source for the action set, its cooldowns, and
// its visible labels. Owns `useActionCooldown` so the 250ms cooldown ticker
// re-renders only this grid, never the surrounding panel (stat card, pet
// renderer, need bars).

"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  CookieIcon,
  DropletsIcon,
  Gamepad2Icon,
  GiftIcon,
  HeartIcon,
  MessageCircleIcon,
  MoonIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useActionCooldown } from "@/hooks/pet/use-action-cooldown"

export interface PetActionGridProps {
  onFeed: () => void
  onPlay: () => void
  onPet: () => void
  onSleep: () => void
  onClean: () => void
  onTreat: () => void
  /** Whether the talk composer is open (highlights the talk toggle). */
  talkOpen: boolean
  onToggleTalk: () => void
  className?: string
}

interface ActionDef {
  kind: string
  labelKey: string
  Icon: ComponentType<{ className?: string }>
  run: () => void
  cooldownMs: number
}

export function PetActionGrid({
  onFeed,
  onPlay,
  onPet,
  onSleep,
  onClean,
  onTreat,
  talkOpen,
  onToggleTalk,
  className,
}: PetActionGridProps) {
  const t = useTranslations("pet")
  // Cooldowns live in the per-window zustand store (UI-only spam gate — the
  // controller processes every event). In the popup window that store is a
  // fresh instance, so cooldowns reset when the popup reopens; acceptable by
  // design, and they must NOT join the persisted {minimized, position} slice.
  const { remaining, trigger } = useActionCooldown()

  // `kind` matches the emitted PetEvent kind so the cooldown is keyed
  // identically across every surface — same key, same gate.
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
    <div data-testid="pet-action-grid" className={cn("grid grid-cols-4 gap-2", className)}>
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
            className="h-auto flex-col gap-1 py-2"
            onClick={() => {
              a.run()
              trigger(a.kind, a.cooldownMs)
            }}
          >
            {cooling ? (
              <span
                data-testid={`pet-cooldown-${a.kind}`}
                className="text-xs leading-4 tabular-nums"
              >
                {Math.ceil(rem / 1000)}
              </span>
            ) : (
              <a.Icon className="size-4" />
            )}
            <span className="text-[10px] leading-none">{t(a.labelKey)}</span>
          </Button>
        )
      })}
      <Button
        size="sm"
        variant={talkOpen ? "default" : "secondary"}
        aria-label={t("actions.talk")}
        className="h-auto flex-col gap-1 py-2"
        onClick={onToggleTalk}
      >
        <MessageCircleIcon className="size-4" />
        <span className="text-[10px] leading-none">{t("actions.talk")}</span>
      </Button>
    </div>
  )
}
