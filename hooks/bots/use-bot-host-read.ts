"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { useHostProfile } from "@/hooks/use-host-profile"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { hostGrantGate } from "@/lib/runtime/operation-availability"
import { transport } from "@/lib/tauri"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"

function subscribePairing(listener: () => void) {
  window.addEventListener("cognia:companion-config-changed", listener)
  return () => window.removeEventListener("cognia:companion-config-changed", listener)
}

/** What `bot_console_read` needs (`protocol/companion-commands.json`). */
const BOT_CONSOLE_READ_CAPABILITY = getCommandDescriptor("bot_console_read")?.capability

/** Live host console reads; no mirrored configuration or credential store on the companion. */
export function useBotHostRead<T>(view: "catalog" | "installations" | "credentials") {
  const profile = useHostProfile()
  const pairing = useSyncExternalStore(subscribePairing, getCompanionConfigGeneration, () => 0)
  const target = useSyncExternalStore(
    subscribeActiveRemoteTransport,
    getActiveRemoteTransport,
    () => null
  )
  const remote = Boolean(target) || profile === "mobile-companion" || profile === "cloud-companion"
  // The paired Host's manifest says whether this device may read its console
  // (an org member's device may not). Before it lands the read waits instead
  // of being refused; a remote host this desktop drives answers for itself.
  const snapshot = useRuntimeSnapshot()
  const gate =
    target || !BOT_CONSOLE_READ_CAPABILITY
      ? "ask"
      : hostGrantGate(snapshot, BOT_CONSOLE_READ_CAPABILITY)
  const [received, setReceived] = useState<{
    target: typeof target
    pairing: number
    view: string
    data?: T
    failed?: boolean
  }>()
  useEffect(() => {
    if (!remote || gate !== "ask") return
    let stopped = false
    let refused = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const data = await (target ?? transport).call<T>("bot_console_read", { view })
        const value = data as Record<string, unknown> | null
        if (
          !value ||
          (view === "catalog" && !Array.isArray(value.entries)) ||
          (view === "installations" && !Array.isArray(value.rows)) ||
          (view === "credentials" && (!value.groups || typeof value.groups !== "object"))
        )
          throw new Error("Invalid Bot host read response")
        if (!stopped && pairing === getCompanionConfigGeneration())
          setReceived({ target, pairing, view, data })
      } catch (error) {
        // A refusal the Host marks final (an org member asking for the
        // operator's console: 403 `host_surface_forbidden`) is the same answer
        // on every poll; asked every 3 s, it was a 403 per poll for as long as
        // a page with a Bot badge stayed open. Stop asking until the pairing
        // or the view changes. A transient failure is retried as before.
        if ((error as { retryable?: unknown } | null)?.retryable === false) refused = true
        if (!stopped && pairing === getCompanionConfigGeneration())
          setReceived({ target, pairing, view, failed: true })
      } finally {
        if (!stopped && !refused) timer = setTimeout(read, 3000)
      }
    }
    void read()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [remote, gate, target, pairing, view])
  const current =
    received?.target === target && received.pairing === pairing && received.view === view
      ? received
      : undefined
  // A console the Host has said this device may not read reads as the refusal
  // it would have answered.
  const lacks = gate === "lacks"
  return {
    remote,
    data: remote && !lacks ? current?.data : undefined,
    loading: remote && !lacks && !current,
    failed: remote && (lacks || Boolean(current?.failed)),
  }
}
