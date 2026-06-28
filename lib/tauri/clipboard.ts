"use client"

import {
  readImage as readImageNative,
  readText as readTextNative,
  writeImage as writeImageNative,
  writeText as writeTextNative,
  clear as clearNative,
} from "@tauri-apps/plugin-clipboard-manager"
import { isTauri } from "@/lib/tauri"
import { readText as capReadText, writeText as capWriteText } from "@/lib/capacitor/clipboard"

/**
 * Read the system clipboard as text. Routes Tauri → desktop plugin, Capacitor
 * mobile → native pasteboard, browser → `navigator.clipboard`. Returns `null`
 * if no backend is available. The Capacitor wrapper self-gates to mobile, so
 * the call is a fast `unsupported` no-op on web / Tauri.
 */
export async function readClipboardText(): Promise<string | null> {
  if (isTauri()) {
    try {
      return await readTextNative()
    } catch (err) {
      console.warn("readClipboardText failed", err)
      return null
    }
  }
  const cap = await capReadText()
  if (cap.kind === "ok") return cap.value
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Write text to the system clipboard. Routes Tauri → desktop plugin, Capacitor
 * mobile → native pasteboard, browser → `navigator.clipboard`.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    await writeTextNative(text)
    return
  }
  const cap = await capWriteText(text)
  if (cap.kind === "ok") return
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
  }
}

/**
 * Read the clipboard as raw image bytes. Tauri-only; returns `null` outside
 * the desktop runtime (browsers can't expose this synchronously without
 * permission prompts the user has not granted).
 */
export async function readClipboardImage(): Promise<Uint8Array | null> {
  if (!isTauri()) return null
  try {
    const img = await readImageNative()
    return new Uint8Array(await img.rgba())
  } catch (err) {
    console.warn("readClipboardImage failed", err)
    return null
  }
}

/** Write raw bytes (PNG/JPEG-encoded or RGBA) to the clipboard as an image. */
export async function writeClipboardImage(bytes: Uint8Array): Promise<void> {
  if (!isTauri()) return
  await writeImageNative(bytes)
}

/** Clear the system clipboard. */
export async function clearClipboard(): Promise<void> {
  if (!isTauri()) return
  await clearNative()
}
