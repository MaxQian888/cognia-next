"use client"

// OS notification permission for the preferences CTA (ADR-0042). Does NOT
// prompt on mount — `request()` is wired to an explicit button so the OS prompt
// only appears on clear user intent. After a (re)request it refreshes the
// runtime's cached permission so the next `notify()` reflects the new grant.

import { useCallback, useEffect, useState } from "react"
import { checkNotificationPermission, ensureNotificationPermission } from "@/lib/tauri/notification"
import { refreshOsPermission } from "@/lib/notifications/runtime"

export type OsPermissionState = "default" | "granted" | "denied"

export function useNotificationPermission() {
  const [state, setState] = useState<OsPermissionState>("default")
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    let cancelled = false
    void checkNotificationPermission().then((result) => {
      if (cancelled) return
      if (result === "granted") refreshOsPermission()
      setState(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const request = useCallback(async (): Promise<OsPermissionState> => {
    setRequesting(true)
    try {
      const result = await ensureNotificationPermission()
      refreshOsPermission()
      setState(result)
      return result
    } finally {
      setRequesting(false)
    }
  }, [])

  return { state, requesting, request, granted: state === "granted" }
}
