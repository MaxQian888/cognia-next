"use client"

import type { ReactNode } from "react"

import { useRecoveryGate } from "@/hooks/recovery/use-recovery-gate"
import { SafeModeShell } from "@/components/recovery/safe-mode-shell"

/**
 * The recovery boot gate (ADR-0102 §4).
 *
 * Mount position is the whole contract: **after** account unlock, locale,
 * logging and Tauri IPC — the shell needs all four to render and to talk to the
 * controller — and **before** the plugin and background initializers, because
 * holding those back is what safe mode *is*. Moving this below them would make
 * it decorative.
 *
 * Off-desktop the hook resolves to `normal` synchronously, so web and mobile
 * mount their children on the first render with no added latency and no flash.
 */
export function RecoveryBootGate({ children }: { children: ReactNode }) {
  const { status, state, probing, retry } = useRecoveryGate()

  if (status === "checking") {
    // Deliberately blank rather than a spinner: this is a sub-frame IPC round
    // trip on the desktop and never renders at all elsewhere. A spinner here
    // would flash on every healthy boot.
    return null
  }

  if (status === "safe") {
    return <SafeModeShell state={state} probing={probing} onRetry={retry} />
  }

  return <>{children}</>
}
