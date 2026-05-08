"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/splash-screen` wrapper. The boot provider hides the splash
 * once the first paint is ready (after platform detection + secure storage
 * unlocks); this wrapper lets that path stay platform-agnostic.
 */

interface SplashScreenShape {
  show(opts?: { showDuration?: number; fadeInDuration?: number; autoHide?: boolean }): Promise<void>
  hide(opts?: { fadeOutDuration?: number }): Promise<void>
}

export type SplashScreenLoader = () => Promise<SplashScreenShape>

const defaultLoader: SplashScreenLoader = makeDefaultLoader<SplashScreenShape>(
  "@capacitor/splash-screen",
  "SplashScreen"
)

export interface ShowOptions {
  showDuration?: number
  fadeInDuration?: number
  autoHide?: boolean
  loader?: SplashScreenLoader
}

export async function show(opts: ShowOptions = {}): Promise<SimpleOutcome> {
  const { loader = defaultLoader, ...rest } = opts
  return withPlugin(loader, async (s) => {
    await s.show(rest)
    return { kind: "ok" as const }
  })
}

export async function hide(
  fadeOutDurationMs?: number,
  loader: SplashScreenLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (s) => {
    await s.hide({ fadeOutDuration: fadeOutDurationMs })
    return { kind: "ok" as const }
  })
}
