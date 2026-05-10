"use client"

import { useEffect, useState } from "react"

import { usePlatform } from "@/hooks/use-platform"

/**
 * Soft-keyboard inset reading via the `visualViewport` API.
 *
 * On Capacitor (`usePlatform() === "mobile"`) the soft keyboard reduces
 * `visualViewport.height` without changing `window.innerHeight`. The gap
 * is the keyboard's pixel height. On desktop / web this hook stays at
 * the zero state — it's a no-op until the user is on a real phone.
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
    const vv = window.visualViewport
    if (!vv) return

    const compute = () => {
      const innerHeight = window.innerHeight ?? 0
      const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop)
      setInsets({ keyboardHeight: kb, isVisible: kb > 0 })
    }

    compute()
    vv.addEventListener("resize", compute)
    vv.addEventListener("scroll", compute)
    return () => {
      vv.removeEventListener("resize", compute)
      vv.removeEventListener("scroll", compute)
      setInsets(ZERO)
    }
  }, [platform])

  return insets
}
