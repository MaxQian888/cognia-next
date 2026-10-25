"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { useHostProfile } from "@/hooks/use-host-profile"
import { transport } from "@/lib/tauri"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"

function subscribePairing(listener: () => void) {
  window.addEventListener("cognia:companion-config-changed", listener)
  return () => window.removeEventListener("cognia:companion-config-changed", listener)
}

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
  const [received, setReceived] = useState<{
    target: typeof target
    pairing: number
    view: string
    data?: T
    failed?: boolean
  }>()
  useEffect(() => {
    if (!remote) return
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
  }, [remote, target, pairing, view])
  const current =
    received?.target === target && received.pairing === pairing && received.view === view
      ? received
      : undefined
  return {
    remote,
    data: remote ? current?.data : undefined,
    loading: remote && !current,
    failed: remote && Boolean(current?.failed),
  }
}
