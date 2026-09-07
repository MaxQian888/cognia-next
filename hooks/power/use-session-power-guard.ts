"use client"

/**
 * Holds the screen for exactly the conversations that asked for it, for exactly
 * as long as they are running.
 *
 * Mounted once at the app root, not per chat pane. A conversation streaming in
 * the background is the case the whole feature exists for: the user started a
 * long turn, switched away, and put the laptop down. A hook that lived in the
 * visible pane would have dropped the hold the moment they navigated.
 */

import { useEffect, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { inFlightSessionIds } from "@/lib/chat/aggregate-run-state"
import { getSessionsByIds } from "@/lib/db/sessions"
import { resolveDefaultPowerMode, sessionsHoldingScreen } from "@/lib/power/session-power-policy"
import { releaseAllScreenWakeHolders, syncScreenWakeHolders } from "@/lib/power/screen-wake-lock"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"

export function useSessionPowerGuard(): void {
  const sessions = useChatStore((s) => s.sessions)
  const appDefault = resolveDefaultPowerMode(useSettingsStore((s) => s.settings))

  // One scan per store tick, and a STABLE key out of it: this store updates on
  // every streamed token, and re-running the Dexie read for each one would put
  // a query on the token path.
  const runningIds = useMemo(() => inFlightSessionIds(sessions), [sessions])
  const runningKey = runningIds.join(",")

  const rows = useLiveQuery(
    () => getSessionsByIds(runningKey ? runningKey.split(",") : []),
    [runningKey]
  )

  const holders = useMemo(
    () =>
      sessionsHoldingScreen({
        runningSessionIds: runningKey ? runningKey.split(",") : [],
        sessions: rows ?? [],
        appDefault,
      }),
    [runningKey, rows, appDefault]
  )
  const holderKey = holders.join(",")

  useEffect(() => {
    void syncScreenWakeHolders(holderKey ? holderKey.split(",") : [])
  }, [holderKey])

  // The lock outlives React state, so an unmount that did not release would
  // leave the display pinned until the process exits.
  useEffect(() => () => void releaseAllScreenWakeHolders(), [])
}
