// The shared care-action grid (feed/play/pet/sleep/clean/treat + the talk
// toggle) used by both the compact interaction panel (widget/popup) and the
// wide `/pet` nurture tab — one source for the action set, its cooldowns, and
// its visible labels. Owns `useActionCooldown` so the 250ms cooldown ticker
// re-renders only this grid, never the surrounding panel (stat card, pet
// renderer, need bars).

"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { CookieIcon, DropletsIcon, Gamepad2Icon, GiftIcon, HeartIcon, MoonIcon } from "lucide-react"
import {
  AnimatedActionIcon,
  type AnimatedIconComponent,
} from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { HeartIcon as AnimatedHeartIcon } from "@/components/ui/heart"
import { MessageCircleIcon as AnimatedMessageCircleIcon } from "@/components/ui/message-circle"
import { MoonIcon as AnimatedMoonIcon } from "@/components/ui/moon"
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
}

const ANIMATED_ACTION_ICONS: Partial<Record<string, AnimatedIconComponent>> = {
  petted: AnimatedHeartIcon,
  slept: AnimatedMoonIcon,
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
  // The cooldown is read, not owned. Its durations and its enforcement live in
  // `lib/pet/interaction/gate.ts` and run in the controller, so this grid, the
  // overlay, the popup, the tray and the agent all obey one deadline. When a
  // UI file owned the numbers, the button greyed out correctly while every
  // other path farmed the same action freely.
  const { remaining } = useActionCooldown()

  // `kind` matches the emitted PetEvent kind, which is also the key the gate
  // stores its deadline under, so a surface reads exactly what it wrote.
  const actions: ActionDef[] = [
    { kind: "fed", labelKey: "actions.feed", Icon: CookieIcon, run: onFeed },
    { kind: "played", labelKey: "actions.play", Icon: Gamepad2Icon, run: onPlay },
    {
      kind: "petted",
      labelKey: "actions.pet",
      Icon: HeartIcon,
      run: onPet,
    },
    {
      kind: "slept",
      labelKey: "actions.sleep",
      Icon: MoonIcon,
      run: onSleep,
    },
    {
      kind: "cleaned",
      labelKey: "actions.clean",
      Icon: DropletsIcon,
      run: onClean,
    },
    { kind: "treated", labelKey: "actions.treat", Icon: GiftIcon, run: onTreat },
  ]

  return (
    <div data-testid="pet-action-grid" className={cn("grid grid-cols-4 gap-2", className)}>
      {actions.map((a) => {
        const rem = remaining(a.kind)
        const cooling = rem > 0
        const AnimatedIcon = ANIMATED_ACTION_ICONS[a.kind]
        return (
          <Button
            key={a.kind}
            size="sm"
            variant="secondary"
            disabled={cooling}
            data-action={a.kind}
            aria-label={t(a.labelKey)}
            className="h-auto flex-col gap-1 py-2"
            onClick={() => a.run()}
          >
            {cooling ? (
              <span
                data-testid={`pet-cooldown-${a.kind}`}
                className="text-xs leading-4 tabular-nums"
              >
                {Math.ceil(rem / 1000)}
              </span>
            ) : AnimatedIcon ? (
              <AnimatedActionIcon icon={AnimatedIcon} size={16} />
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
        <AnimatedActionIcon icon={AnimatedMessageCircleIcon} size={16} animateOnChange={talkOpen} />
        <span className="text-[10px] leading-none">{t("actions.talk")}</span>
      </Button>
    </div>
  )
}
