"use client"

// ADR-0028 §UI surfaces / §T4 — composer shield indicator.
//
// Three visual states keyed off the resolved sandbox precedence chain
// (session → character → app settings), with shape paired to colour for
// colour-blind safety:
//
//   - filled  Shield      / emerald — sandbox enabled, OS tier
//   - dashed  Shield      / sky     — sandbox enabled, microvm tier
//   - crossed ShieldOff   / muted   — sandbox disabled (today's default)

import { Shield, ShieldOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { getCharacter } from "@/lib/db/characters"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@/lib/claude/types"

export type ShieldState = "os" | "microvm" | "off"

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
  characterSandboxTier?: "os" | "microvm"
  defaultEnabled?: boolean
  defaultTier?: "os" | "microvm"
}): ShieldState {
  const enabled =
    args.session?.sandboxEnabled ?? args.characterSandboxEnabled ?? args.defaultEnabled ?? false
  if (!enabled) return "off"
  const tier = args.characterSandboxTier ?? args.defaultTier ?? "os"
  return tier
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
