"use client"

import type { AppHandoffTarget } from "@/lib/oauth/app-handoff"

import { asNonThenable } from "./_shared"

/**
 * The app-local `CogniaAppHandoff` plugin (Android
 * `CogniaAppHandoffPlugin.java`, iOS `CogniaAppHandoff.swift`): hand a link
 * to one known app, chosen natively by target.
 *
 * Android opens the link in the target's package, so the system never shows
 * a chooser: on devices without Google services the target's App Link
 * verification fails and a bare `VIEW` intent offers the browser as well.
 * iOS opens it as a universal link only, which fails rather than falling
 * back to Safari when the app is missing.
 */
interface AppHandoffPlugin {
  isAvailable(options: { target: AppHandoffTarget }): Promise<unknown>
  open(options: { target: AppHandoffTarget; url: string }): Promise<unknown>
}

export type AppHandoffLoader = () => Promise<AppHandoffPlugin>

const defaultLoader: AppHandoffLoader = async () => {
  // App-local plugin, without an npm package or web shim: registerNativePlugins
  // creates its proxy from the native PluginHeaders.
  const plugin = (
    globalThis as unknown as {
      Capacitor?: { Plugins?: { CogniaAppHandoff?: AppHandoffPlugin } }
    }
  ).Capacitor?.Plugins?.CogniaAppHandoff
  if (!plugin) throw new Error("CogniaAppHandoff is unavailable")
  return asNonThenable(plugin)
}

/** The availability probe never holds a sign-in up for longer than this. */
const PROBE_TIMEOUT_MS = 2_000

/** Whether the target app is installed and can take its links. False when unknown. */
export async function isAppHandoffAvailable(
  target: AppHandoffTarget,
  loader: AppHandoffLoader = defaultLoader
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(async () => (await loader()).isAvailable({ target })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS)
      }),
    ])
    return isRecord(result) && result.available === true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Hand `url` to the target app. False when the app did not take it. */
export async function openInApp(
  target: AppHandoffTarget,
  url: string,
  loader: AppHandoffLoader = defaultLoader
): Promise<boolean> {
  try {
    const result = await (await loader()).open({ target, url })
    return isRecord(result) && result.opened === true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
