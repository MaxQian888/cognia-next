"use client"

import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link"
import { isTauri } from "@/lib/tauri"

export type DeepLinkHandler = (urls: string[]) => void

/**
 * Subscribe to incoming `cognia://` URLs while the app is running. Returns
 * an unsubscribe function.
 *
 * No-op outside Tauri.
 */
export async function onDeepLink(handler: DeepLinkHandler): Promise<() => void> {
  if (!isTauri()) return () => {}
  return await onOpenUrl((urls) => handler(urls))
}

/**
 * Read the URL the app was launched with (if any). Useful on first paint to
 * route the user directly into the requested chat / workspace.
 */
export async function getLaunchDeepLink(): Promise<string[] | null> {
  if (!isTauri()) return null
  try {
    return (await getCurrent()) ?? null
  } catch (err) {
    console.warn("getLaunchDeepLink failed", err)
    return null
  }
}
