"use client"

/**
 * Whether the chat composer can send right now, and what to tell the user when
 * it cannot.
 *
 * The desktop workspace (`components/desktop/desktop-chat-workspace.tsx`)
 * resolved this inline and gated its composer on it; the phone shell never
 * resolved it at all, so a paired phone whose host was offline, unpaired, or
 * missing the chat grant still showed a live composer whose sends went nowhere.
 * This is the same resolution — the same command (`claude_send`), the same
 * facts, the same recovery routing — as a hook both shells can call, so the two
 * gates cannot drift apart.
 */

import { useMemo } from "react"

import { usePlatform } from "@/hooks/use-platform"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  resolveOperationAvailability,
  type OperationAvailability,
  type OperationAvailabilityState,
} from "@/lib/runtime/operation-availability"
import {
  resolveRuntimeRecovery,
  type RuntimeRecoveryDestination,
} from "@/lib/runtime/recovery-resolver"

export interface ChatRuntimeGate {
  availability: OperationAvailability
  /** Anything but `available` — the composer must not accept a send. */
  composerDisabled: boolean
  /** Where the notice's action button takes the user, if anywhere. */
  recovery: RuntimeRecoveryDestination
  /** The host link is (re)connecting rather than down. */
  connecting: boolean
}

export function useChatRuntimeGate(): ChatRuntimeGate {
  const platform = usePlatform()
  const snapshot = useRuntimeSnapshot()
  return useMemo(() => {
    const availability = resolveOperationAvailability({
      snapshot,
      command: "claude_send",
      localExecutorAvailable: snapshot.target?.kind === "standalone",
      readOnlyFallback: true,
    })
    return {
      availability,
      composerDisabled: availability.state !== "available",
      recovery: resolveRuntimeRecovery(availability, platform),
      connecting: snapshot.connectionState === "connecting",
    }
  }, [snapshot, platform])
}

/**
 * `desktop.chatRuntime.states.*` key for an availability state
 * (`requires-pairing` → `requiresPairing`).
 */
export function runtimeAvailabilityMessageKey(state: OperationAvailabilityState): string {
  return state.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
