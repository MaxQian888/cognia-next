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

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { getCharacter } from "@/lib/db/characters"
import { updateSession } from "@/lib/db/sessions"
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
      //
      // Muted, not violet: the tier is withdrawn — `SandboxSessionRuntime`
      // refuses the binding — so the badge must not read as active protection
      // at the exact moment nothing is protecting the shell.
      <MonitorCheck
        className={cn("size-3.5 text-muted-foreground", className)}
        aria-hidden="true"
      />
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

  // A tier stored on the session is pinned: it no longer follows the character
  // or the app default. `lib/sandbox/pin-session-tier.ts` writes it on the first
  // sandboxed send so a default changed elsewhere cannot re-tier a conversation
  // mid-flight. A pin with no way out would be worse than the drift it fixes,
  // so releasing it lives right here, on the badge that reports it.
  const pinned = state !== "off" && !!session?.sandboxTier
  const sessionId = session?.id

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sandbox-shield"
          data-state={state}
          data-pinned={pinned ? "true" : "false"}
          aria-label={ariaLabel}
          title={tooltip}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
        >
          {icon}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-72 space-y-2 p-3">
        <p className="text-sm font-medium">{ariaLabel}</p>
        <p className="text-xs text-muted-foreground">{tooltip}</p>
        {state !== "off" && (
          <div className="space-y-2 border-t pt-2">
            <p className="text-xs text-muted-foreground">
              {pinned ? t("pinnedDetail") : t("inheritedDetail")}
            </p>
            {pinned && sessionId && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                data-testid="sandbox-shield-unpin"
                onClick={() => {
                  // Both halves. Clearing the tier alone leaves a session that
                  // is indistinguishable from one that was never pinned, and
                  // `pin-session-tier.ts` pins that on the next send — so the
                  // release has to say it was a release.
                  void updateSession(sessionId, {
                    sandboxTier: undefined,
                    sandboxTierFollowsDefault: true,
                  })
                }}
              >
                {t("unpin")}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
