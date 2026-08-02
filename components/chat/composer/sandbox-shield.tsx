"use client"

// ADR-0028 §UI surfaces / §T4 — composer shield indicator.
//
// Three visual states keyed off the resolved sandbox precedence chain
// (session → character → app settings), with shape paired to colour for
// colour-blind safety:
//
//   - filled  Shield      / emerald — sandbox enabled, OS tier
//   - dashed  Shield      / sky     — sandbox enabled, microvm tier
//   - monitor MonitorCheck/ violet  — sandbox enabled, cua-desktop tier: shell,
//                                     file AND GUI work run inside a bound
//                                     sandbox connection (Epic 5)
//   - crossed ShieldOff   / muted   — sandbox disabled (today's default)

import { MonitorCheck, Shield, ShieldOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { getCharacter } from "@/lib/db/characters"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SandboxShellTier } from "@/types/sandbox"

export type ShieldState = "os" | "microvm" | "cua-desktop" | "off"

export interface SandboxShieldProps {
  session: ChatSession | null
  /** Test-only override of the resolved state. Production code leaves this undefined. */
  forceState?: ShieldState
  className?: string
}

/** Pure precedence resolver — exposed for unit-testing without rendering. */
export function resolveShieldState(args: {
  session: ChatSession | null | undefined
  characterSandboxEnabled?: boolean
  characterSandboxTier?: SandboxShellTier
  defaultEnabled?: boolean
  defaultTier?: "os" | "microvm"
}): ShieldState {
  const enabled =
    args.session?.sandboxEnabled ?? args.characterSandboxEnabled ?? args.defaultEnabled ?? false
  if (!enabled) return "off"
  // Same ladder `lib/sandbox/binding.ts` uses, so the badge and the actual
  // routing decision can never disagree.
  return args.session?.sandboxTier ?? args.characterSandboxTier ?? args.defaultTier ?? "os"
}

export function SandboxShield({ session, forceState, className }: SandboxShieldProps) {
  const t = useTranslations("chat.composer.sandboxShield")
  const settings = useSettingsStore((s) => s.settings)
  const characterId = session?.characterId
  const character = useLiveQuery(
    () => (characterId ? getCharacter(characterId) : Promise.resolve(undefined)),
    [characterId]
  )

  const state = useMemo<ShieldState>(() => {
    if (forceState) return forceState
    return resolveShieldState({
      session,
      characterSandboxEnabled: character?.sandboxEnabled,
      characterSandboxTier: character?.sandboxTier,
      defaultEnabled: settings?.sandboxDefaultEnabled,
      defaultTier: settings?.sandboxTier,
    })
  }, [
    forceState,
    session,
    character?.sandboxEnabled,
    character?.sandboxTier,
    settings?.sandboxDefaultEnabled,
    settings?.sandboxTier,
  ])

  const ariaLabel = t(`label.${state}`)
  const tooltip = t(`tooltip.${state}`)

  const icon =
    state === "off" ? (
      <ShieldOff className={cn("size-3.5 text-muted-foreground", className)} aria-hidden="true" />
    ) : state === "cua-desktop" ? (
      // A distinct glyph, not a differently-coloured shield: this tier moves
      // execution onto another machine entirely, which is a bigger claim than
      // "isolated here" and should not be mistaken for one at a glance.
      <MonitorCheck className={cn("size-3.5 text-violet-500", className)} aria-hidden="true" />
    ) : (
      <Shield
        className={cn(
          "size-3.5",
          state === "os" && "text-emerald-500",
          state === "microvm" && "text-sky-500 [stroke-dasharray:3_2] [stroke-linejoin:round]",
          className
        )}
        aria-hidden="true"
      />
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="sandbox-shield"
          data-state={state}
          role="img"
          aria-label={ariaLabel}
          className="inline-flex size-7 items-center justify-center"
        >
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
