"use client"

import type { ReactNode } from "react"

import { useRecoveryGate } from "@/hooks/recovery/use-recovery-gate"
import { SafeModeShell } from "@/components/recovery/safe-mode-shell"
import { PageLoading } from "@/components/ui/loading-states"

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
    // A sub-frame IPC round trip on the desktop, never rendered elsewhere.
    // This used to be `null` so that no spinner would flash on a healthy boot
    // — but the account gate has just been showing the boot screen, and a
    // blank frame between it and the shell *is* the flash. Rendering the same
    // screen, standing for its `preferences` step, keeps the wait continuous;
    // the screen carries its state across mounts (lib/boot/boot-progress.ts),
    // so nothing re-animates.
    return <PageLoading variant="workspace" milestone="preferences" allowReload />
  }

  if (status === "safe") {
    return <SafeModeShell state={state} probing={probing} onRetry={retry} />
  }

  return <>{children}</>
}
