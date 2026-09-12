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
      } catch {
        if (!stopped && pairing === getCompanionConfigGeneration())
          setReceived({ target, pairing, view, failed: true })
      } finally {
        if (!stopped) timer = setTimeout(read, 3000)
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
