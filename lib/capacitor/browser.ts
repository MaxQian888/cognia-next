"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/browser` wrapper. Used by the OAuth flow (Wave 1.8) to open
 * external login pages without leaving the app — the in-app browser keeps
 * the deeplink callback within Capacitor's lifecycle reach.
 */

interface BrowserShape {
  open(opts: {
    url: string
    windowName?: string
    toolbarColor?: string
    presentationStyle?: "fullscreen" | "popover"
  }): Promise<void>
  close(): Promise<void>
  addListener(
    event: "browserFinished" | "browserPageLoaded",
    handler: () => void
  ): Promise<{ remove(): Promise<void> | void }>
}

export type BrowserLoader = () => Promise<BrowserShape>

const defaultLoader: BrowserLoader = makeDefaultLoader<BrowserShape>(
  "@capacitor/browser",
  "Browser"
)

export interface OpenOptions {
  url: string
  toolbarColor?: string
  presentationStyle?: "fullscreen" | "popover"
  loader?: BrowserLoader
}

export async function open(opts: OpenOptions): Promise<SimpleOutcome> {
  const { url, toolbarColor, presentationStyle, loader = defaultLoader } = opts
  return withPlugin(loader, async (b) => {
    await b.open({ url, toolbarColor, presentationStyle })
    return { kind: "ok" as const }
  })
}

export async function close(loader: BrowserLoader = defaultLoader): Promise<SimpleOutcome> {
  return withPlugin(loader, async (b) => {
    await b.close()
    return { kind: "ok" as const }
  })
}

export type BrowserEvent = "finished" | "loaded"
export type Unsubscribe = () => void

export async function onClose(
  handler: () => void,
  loader: BrowserLoader = defaultLoader
): Promise<Unsubscribe> {
  try {
    const b = await loader()
    const listener = await b.addListener("browserFinished", handler)
    return () => {
      void listener.remove()
    }
  } catch {
    return () => {}
  }
}
