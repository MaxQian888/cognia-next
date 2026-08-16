"use client"

/**
 * Remote-control capability probe (mobile).
 *
 * A paired phone receives every `/ws/events` frame — including host
 * computer-use `automation:consent-request` prompts — regardless of whether it
 * holds the elevated remote-control capability. Acting on one (`
 * automation_consent_respond`) is gated server-side against the host's
 * SecurityStore capabilities (granted by the paired-devices remote-control
 * toggle), so an observe-only device would 403 on tap.
 *
 * This hook asks the host once via the read-only `companion_can_control` RPC so
 * the consent sheet can stay hidden on observe-only devices instead of
 * surfacing a prompt that fails. Distinct from `use-remote-session-stream`'s
 * `canControl`, which is *reactive* (it infers the capability from a 403 on
 * `session_attach`); this is a proactive query with no side effect.
 *
 * - On desktop / web the consumer never mounts, but we default to `true`
 *   defensively (the desktop drives automation locally).
 * - On mobile, `"unknown"` until the probe resolves; a failed probe (not
 *   paired, offline, server too old) stays `"unknown"` so the sheet stays
 *   hidden, and a later mount retries.
 */

import { useEffect, useState } from "react"

import { transport } from "@/lib/tauri"
import { usePlatform } from "@/hooks/use-platform"

export type ControlCapability = boolean | "unknown"

export function useCanControl(): ControlCapability {
  const platform = usePlatform()
  const [probed, setProbed] = useState<ControlCapability>("unknown")

  useEffect(() => {
    if (platform !== "mobile") return
    let cancelled = false
    transport
      .call<{ allowed: boolean }>("companion_can_control")
      .then((res) => {
        if (!cancelled) setProbed(res?.allowed === true)
      })
      .catch(() => {
        if (!cancelled) setProbed("unknown")
      })
    return () => {
      cancelled = true
    }
  }, [platform])

  // Off mobile the consent consumer never mounts; default to allowing (the
  // desktop drives automation locally). On mobile, surface the probe result —
  // derived here rather than written via setState so the effect stays a pure
  // subscription (react-hooks/set-state-in-effect).
  return platform === "mobile" ? probed : true
}
