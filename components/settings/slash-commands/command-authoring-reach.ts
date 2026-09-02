"use client"

/**
 * Where a custom slash command can be authored FROM.
 *
 * The section used to answer this with `const desktop = isTauri()`, and then
 * hide create / edit / delete whenever it was false. That collapsed three
 * different situations into one silence:
 *
 *  - a browser with nothing paired, which genuinely cannot write anywhere and
 *    is one pairing away from being able to,
 *  - a phone or browser paired to a host, which CAN write this repository's
 *    `.claude/commands` over `fs_write_workspace_file` and was being told it
 *    could not,
 *  - the user-global `~/.claude/commands`, which sits outside every workspace
 *    root and really is desktop-only, for a reason no amount of pairing
 *    changes.
 *
 * So there are two reaches, not one, and both are rendered rather than hidden.
 */

import { useMemo } from "react"

import type { HostProfile } from "@/lib/platform/capabilities"
import { resolveSurfaceReach, type SurfaceReach } from "@/lib/platform/surface-reach"
import { useHostProfile } from "@/hooks/use-host-profile"

export interface CommandAuthoringReach {
  /** `<cwd>/.claude/commands` and `<cwd>/.cognia/commands`. */
  project: SurfaceReach
  /** `~/.claude/commands`. */
  global: SurfaceReach
}

/**
 * Pure resolver, so the answer can be asserted without a React tree.
 *
 * Project authoring asks only for a host, because the write goes through the
 * host-targeted workspace filesystem and any host has one. Global authoring
 * asks for the desktop process itself: a headless host runs plenty of
 * capabilities and still has no `~/.claude` this app may treat as the user's.
 */
export function resolveCommandAuthoringReach(profile: HostProfile): CommandAuthoringReach {
  return {
    project: resolveSurfaceReach({ profile, capabilityAvailable: true }),
    global: resolveSurfaceReach({
      profile,
      capabilityAvailable: true,
      requirement: "desktop-shell",
    }),
  }
}

/** The reach for the shell this is rendering in. */
export function useCommandAuthoringReach(): CommandAuthoringReach {
  const profile = useHostProfile()
  return useMemo(() => resolveCommandAuthoringReach(profile), [profile])
}

/**
 * The i18n key explaining why a scope cannot be authored here, or null when it
 * can. Kept next to the resolver so a new `SurfaceBlock` cannot be added
 * without a sentence to render for it.
 */
export function commandAuthoringBlockKey(reach: SurfaceReach): string | null {
  if (reach.available) return null
  switch (reach.block) {
    case "no-host":
      return "authoring.noHost"
    case "needs-desktop-shell":
      return "authoring.needsDesktop"
    case "host-lacks-capability":
      return "authoring.hostLacks"
    default:
      return "authoring.localLacks"
  }
}
