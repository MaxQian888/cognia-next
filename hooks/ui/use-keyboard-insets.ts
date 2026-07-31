"use client"

import { useEffect, useState } from "react"

import { subscribeKeyboard, type Unsubscribe } from "@/lib/capacitor/keyboard"
import { usePlatform } from "@/hooks/use-platform"

/**
 * Soft-keyboard state with two deliberately different fields:
 *
 * - `keyboardHeight` — how many pixels of the keyboard OVERLAP the layout
 *   viewport (`innerHeight - visualViewport.height - offsetTop`). This is the
 *   extra bottom offset positioning code needs (mention popover, share
 *   target, pair step). Under the shipped `Keyboard.resize: "native"` mode
 *   (`mobile/capacitor.config.ts`) the OS resizes the whole WebView frame, so
 *   the true overlap is 0 — consumers must NOT be pushed up again.
 *
 * - `isVisible` — whether the soft keyboard is OPEN. Under `resize: "native"`
 *   the viewport delta stays ~0 even while typing, so open-state driven UI
 *   (hiding the tab bar) can't rely on the overlap. The native
 *   `@capacitor/keyboard` events are authoritative for this field whenever
 *   the plugin is available; the overlap (> 0) is the fallback signal for
 *   plain mobile browsers / PWA where the plugin never registers.
 *
 * On desktop / web this hook stays at the zero state — it's a no-op until
 * the user is on a real phone.
 *
 * iOS WKWebView has historical bugs around `visualViewport` and input
 * auto-zoom; pair this hook with `font-size: 16px` on inputs to avoid
 * triggering the zoom path.
 */
export interface KeyboardInsets {
  keyboardHeight: number
  isVisible: boolean
}

const ZERO: KeyboardInsets = { keyboardHeight: 0, isVisible: false }

export function useKeyboardInsets(): KeyboardInsets {
  const platform = usePlatform()
  const [insets, setInsets] = useState<KeyboardInsets>(ZERO)

  useEffect(() => {
    if (platform !== "mobile") return
    if (typeof window === "undefined") return

    let cancelled = false
    let unsubNative: Unsubscribe | null = null
    let vvCleanup: (() => void) | null = null

    let overlap = 0
    // `null` until the first native event lands; from then on the native
    // open/closed state wins over the overlap-derived fallback.
    let nativeOpen: boolean | null = null

    const publish = () => {
      setInsets({ keyboardHeight: overlap, isVisible: nativeOpen ?? overlap > 0 })
    }

    const vv = window.visualViewport
    if (vv) {
      const compute = () => {
        const innerHeight = window.innerHeight ?? 0
        overlap = Math.max(0, innerHeight - vv.height - vv.offsetTop)
        publish()
      }
      compute()
      vv.addEventListener("resize", compute)
      vv.addEventListener("scroll", compute)
      vvCleanup = () => {
        vv.removeEventListener("resize", compute)
        vv.removeEventListener("scroll", compute)
      }
    }

    const onShow = () => {
      nativeOpen = true
      publish()
    }
    void subscribeKeyboard({
      onWillShow: onShow,
      onDidShow: onShow,
      onWillHide: () => {
        nativeOpen = false
        publish()
      },
    }).then((unsub) => {
      if (!unsub) return
      if (cancelled) {
        unsub()
        return
      }
      unsubNative = unsub
    })

    return () => {
      cancelled = true
      unsubNative?.()
      vvCleanup?.()
      setInsets(ZERO)
    }
  }, [platform])

  return insets
}
