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
    return { kind: "ok" as const, value: res?.type === "text/plain" ? (res.value ?? "") : "" }
  })
}

/**
 * The native plugin rejects a read of an empty pasteboard with this message
 * ("There is no data on the clipboard") rather than resolving `""`.
 */
const EMPTY_CLIPBOARD_RE = /no data on the clipboard/i

type ClipboardBridgeTarget = Pick<Clipboard, "writeText" | "readText"> & Partial<Clipboard>

const BRIDGED = Symbol.for("cognia.nativeClipboardBridge")

/**
 * Route the WebView's async Clipboard API through the native pasteboard.
 *
 * Roughly eighty call sites write `navigator.clipboard.writeText(…)` directly
 * (table copy, code blocks, share links, invite codes …). Inside the Capacitor
 * Android WebView that API is either absent or rejects with `NotAllowedError`,
 * so every one of them failed silently on device. Rather than rewrite each call
 * site, this installs — once, on native mobile only, after the plugin proxies
 * are registered — `writeText` / `readText` / `write` implementations that go
 * to `@capacitor/clipboard` first and fall back to the WebView's own method.
 *
 * `write(items)` bridges the `text/plain` representation (what every rich-copy
 * caller also provides); an item set without plain text keeps the WebView's
 * behaviour. Returns whether the bridge was installed by this call.
 */
export function installNativeClipboardBridge(
  opts: { nav?: Navigator; loader?: ClipboardLoader } = {}
): boolean {
  const nav = opts.nav ?? (typeof navigator !== "undefined" ? navigator : undefined)
  if (!nav) return false
  const loader = opts.loader ?? defaultLoader
  const original = (nav as { clipboard?: Clipboard }).clipboard
  if (original && (original as unknown as Record<symbol, unknown>)[BRIDGED]) return false

  const originalWriteText = original?.writeText?.bind(original)
  const originalReadText = original?.readText?.bind(original)
  const originalWrite = original?.write?.bind(original)

  const notAllowed = (op: string) =>
    new DOMException(`clipboard ${op} is not available`, "NotAllowedError")

  const bridgedWriteText = async (value: string): Promise<void> => {
    const out = await writeText(value, loader)
    if (out.kind === "ok") return
    if (originalWriteText) return originalWriteText(value)
    throw out.kind === "error" ? new Error(out.message) : notAllowed("write")
  }

  const bridgedReadText = async (): Promise<string> => {
    const out = await readText(loader)
    if (out.kind === "ok") return out.value
    if (out.kind === "error" && EMPTY_CLIPBOARD_RE.test(out.message)) return ""
    if (originalReadText) return originalReadText()
    throw out.kind === "error" ? new Error(out.message) : notAllowed("read")
  }

  const bridgedWrite = async (items: ClipboardItems): Promise<void> => {
    const plain = items.find((item) => item.types.includes("text/plain"))
    if (plain) {
      const text = await (await plain.getType("text/plain")).text()
      const out = await writeText(text, loader)
      if (out.kind === "ok") return
    }
    if (originalWrite) return originalWrite(items)
    throw notAllowed("write")
  }

  const methods = {
    writeText: bridgedWriteText,
    readText: bridgedReadText,
    write: bridgedWrite,
  }

  if (original) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(original, name, { value, configurable: true, writable: true })
    }
    Object.defineProperty(original, BRIDGED, { value: true })
    return true
  }

  // Non-secure-context WebViews expose no `navigator.clipboard` at all.
  const shim = { ...methods, [BRIDGED]: true } as unknown as ClipboardBridgeTarget
  Object.defineProperty(nav, "clipboard", { value: shim, configurable: true })
  return true
}
