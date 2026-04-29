"use client"

import { useState } from "react"
import { toast } from "sonner"
import { isTauri } from "@/lib/tauri"
import { pullAllFromNative, pushAllToNative, type SyncResult } from "@/lib/skills/sync"

export interface UseSkillSync {
  busy: boolean
  push: () => Promise<void>
  pull: () => Promise<void>
}

export function useSkillSync(): UseSkillSync {
  const [busy, setBusy] = useState(false)

  const push = async () => {
    if (!isTauri()) {
      toast.error("Sync requires desktop mode.")
      return
    }
    setBusy(true)
    try {
      const result = await pushAllToNative()
      summariseSync(result, "push")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pull = async () => {
    if (!isTauri()) {
      toast.error("Sync requires desktop mode.")
      return
    }
    setBusy(true)
    try {
      const result = await pullAllFromNative()
      summariseSync(result, "pull")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return { busy, push, pull }
}

function summariseSync(result: SyncResult, kind: "push" | "pull") {
  const parts: string[] = []
  if (kind === "push" && result.pushed > 0) parts.push(`${result.pushed} pushed`)
  if (kind === "pull" && result.pulled > 0) parts.push(`${result.pulled} pulled`)
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
  if (result.errors.length > 0) parts.push(`${result.errors.length} errored`)
  if (result.errors.length > 0) {
    toast.warning(parts.join(", ") || "No changes.")
  } else if (parts.length === 0) {
    toast.info("No changes.")
  } else {
    toast.success(parts.join(", "))
  }
}
