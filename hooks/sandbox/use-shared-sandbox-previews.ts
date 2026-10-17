"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  closeSharedPreview,
  listSharedPreviews,
  openSharedPreview,
  SharedPreviewsError,
} from "@/lib/sandbox/paired-previews"
import type { PairedPreviewSummary } from "@/lib/sandbox/previews"
import { openExternal } from "@/lib/tauri/opener"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

const POLL_MS = 15_000

export type SharedPreviewError = "load" | "forbidden" | "open"

/**
 * Preview grants the Host owner shared with this paired desktop, for one
 * project. Each opened grant owns one native loopback relay; a grant that
 * leaves the Host's list (revoked, expired, control withdrawn) closes it.
 */
export function useSharedSandboxPreviews(endpoint: RemoteHostEndpoint, projectId: string) {
  const [previews, setPreviews] = useState<PairedPreviewSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SharedPreviewError | null>(null)
  const [opened, setOpened] = useState<Record<string, string>>({})
  /** When the Host last answered; remaining lifetimes are shown against it. */
  const [checkedAt, setCheckedAt] = useState(0)
  const relays = useRef(new Set<string>())
  const epoch = useRef(0)

  const close = useCallback(async (id: string) => {
    if (!relays.current.delete(id)) return
    setOpened((previous) => {
      const next = { ...previous }
      delete next[id]
      return next
    })
    await closeSharedPreview(id).catch(() => undefined)
  }, [])

  const load = useCallback(async () => {
    const current = epoch.current
    try {
      const all = await listSharedPreviews(endpoint)
      if (current !== epoch.current) return
      const next = all.filter((preview) => preview.projectId === projectId)
      setPreviews(next)
      setCheckedAt(Date.now())
      setError(null)
      for (const id of [...relays.current]) {
        if (!next.some((preview) => preview.id === id)) void close(id)
      }
    } catch (reason) {
      if (current !== epoch.current) return
      const forbidden = reason instanceof SharedPreviewsError && reason.status === 403
      setError(forbidden ? "forbidden" : "load")
      if (forbidden) {
        setPreviews([])
        for (const id of [...relays.current]) void close(id)
      }
    } finally {
      if (current === epoch.current) setLoading(false)
    }
  }, [endpoint, projectId, close])

  useEffect(() => {
    epoch.current += 1
    const current = epoch.current
    const owned = relays.current
    void Promise.resolve().then(() => {
      if (current === epoch.current) return load()
    })
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      epoch.current += 1
      clearInterval(timer)
      for (const id of owned) void closeSharedPreview(id).catch(() => undefined)
      owned.clear()
    }
  }, [load])

  const open = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const current = epoch.current
    try {
      const existing = opened[id]
      if (existing) {
        await openExternal(existing)
        return
      }
      relays.current.add(id)
      const relay = await openSharedPreview(endpoint, { id })
      if (current !== epoch.current) {
        await closeSharedPreview(id).catch(() => undefined)
        return
      }
      setOpened((previous) => ({ ...previous, [id]: relay.url }))
      await openExternal(relay.url)
    } catch {
      if (current === epoch.current) {
        setError("open")
        await close(id)
      }
    } finally {
      if (current === epoch.current) setBusy(false)
    }
  }

  return {
    previews,
    loading,
    busy,
    error,
    opened,
    checkedAt,
    refresh: async () => {
      setLoading(true)
      await load()
    },
    open,
    close,
  }
}
