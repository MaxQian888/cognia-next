// Tracks whether this document is visible. The OS fires `visibilitychange`
// when a Tauri window is hidden/minimized too, so one DOM signal covers the
// overlay window, the main window, and the browser tab alike. Consumers pass
// `hidden` down as the renderer `paused` prop and as a wander pause input.

"use client"

import { useEffect, useState } from "react"

/** True while the document is hidden (window hidden / minimized / tab away). */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden")
    update()
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  return hidden
}
