"use client"

import { useEffect } from "react"
import { detectPlatform } from "@/lib/platform/detect"
import { startIntegrationRuntime } from "@/lib/integrations/runtime"

export function IntegrationRuntimeInitializer() {
  useEffect(() => {
    const platform = detectPlatform()
    if (platform !== "tauri" && platform !== "headless") return

    let cancelled = false
    let disposeRuntime: (() => void) | undefined
    void startIntegrationRuntime().then((dispose) => {
      if (cancelled) dispose()
      else disposeRuntime = dispose
    })
    return () => {
      cancelled = true
      disposeRuntime?.()
    }
  }, [])

  return null
}

export default IntegrationRuntimeInitializer
