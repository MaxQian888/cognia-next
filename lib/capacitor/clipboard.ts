"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/clipboard` wrapper. Capacitor's Android/iOS WebView frequently
 * leaves `navigator.clipboard` undefined (non-secure-context origin) or throws
 * a `NotAllowedError` outside a synchronous user gesture, so every web copy /
 * paste path silently fails on device. The native plugin reads/writes the
 * platform pasteboard directly and is the only reliable backend on mobile.
 *
 * On web / Tauri the dynamic import collapses to `{ kind: "unsupported" }` via
 * `withPlugin` (exactly like the sibling wrappers), so callers can attempt the
 * native path first and transparently fall back to `navigator.clipboard`.
 */

interface ClipboardShape {
  write(opts: { string?: string; url?: string; image?: string; label?: string }): Promise<void>
  read(): Promise<{ value: string; type: string }>
}

export type ClipboardLoader = () => Promise<ClipboardShape>

const defaultLoader: ClipboardLoader = makeDefaultLoader<ClipboardShape>(
  "@capacitor/clipboard",
  "Clipboard"
)

/** Write plain text to the native clipboard. */
export async function writeText(
  value: string,
  loader: ClipboardLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (c) => {
    await c.write({ string: value })
    return { kind: "ok" as const }
  })
}

/** Read plain text from the native clipboard. */
export async function readText(
  loader: ClipboardLoader = defaultLoader
): Promise<ValueOutcome<string>> {
  return withPlugin(loader, async (c) => {
    const res = await c.read()
    return { kind: "ok" as const, value: res?.value ?? "" }
  })
}
