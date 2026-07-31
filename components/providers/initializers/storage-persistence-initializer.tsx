"use client"

// Fires once on app boot. Two jobs:
//  1. Request persistent storage so the browser won't silently evict our
//     IndexedDB data under pressure (see `lib/storage/persistence-request.ts`).
//  2. Surface a one-time pressure warning when the origin is already near its
//     quota, reusing the warning/critical thresholds `StorageManager.getHealth`
//     computes — we never recompute them here.

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { requestPersistentStorage } from "@/lib/storage/persistence-request"
import { StorageManager } from "@/lib/storage/storage-manager"

export function StoragePersistenceInitializer() {
  const t = useTranslations("mobile.me.storage")
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void (async () => {
      await requestPersistentStorage()
      try {
        const health = await StorageManager.getHealth()
        if (health.status === "warning" || health.status === "critical") {
          const message = t("pressureWarning", { percent: Math.round(health.usagePercent) })
          if (health.status === "critical") toast.error(message)
          else toast.warning(message)
        }
      } catch {
        // Storage estimate unavailable (private mode / old webview) — skip.
      }
    })()
  }, [t])

  return null
}

export default StoragePersistenceInitializer
