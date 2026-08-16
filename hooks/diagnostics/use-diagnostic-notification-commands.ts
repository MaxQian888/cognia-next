"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { installDiagnosticNotificationCommands } from "@/lib/diagnostics/notification-commands"

/**
 * Mount the `diagnostic.*` notification-command executors for the lifetime of
 * the calling component. Lives in a hook because `view-logs` needs the App
 * Router, which only React can hand out; everything else in the installer is
 * shell-neutral.
 */
export function useDiagnosticNotificationCommands(): void {
  const router = useRouter()
  useEffect(
    () => installDiagnosticNotificationCommands({ navigate: (path) => router.push(path) }),
    [router]
  )
}
