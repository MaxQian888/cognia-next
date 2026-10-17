"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  sandboxSnapshotCreate,
  sandboxSnapshotDelete,
  sandboxSnapshotFork,
  sandboxSnapshotList,
  sandboxSnapshotPin,
  sandboxSnapshotRestore,
  type CreateSandboxSnapshot,
  type ForkedSandboxSnapshot,
  type SandboxSnapshot,
} from "@/lib/sandbox/snapshots"

export function useSandboxSnapshots(projectId: string) {
  const [snapshots, setSnapshots] = useState<SandboxSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<"busy" | "budget" | "action" | "load" | null>(null)
  const [forked, setForked] = useState<ForkedSandboxSnapshot | null>(null)
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const [scope, setScope] = useState(projectId)
  if (scope !== projectId) {
    setScope(projectId)
    setSnapshots([])
    setForked(null)
    setBusy(false)
    setLoading(true)
    setError(null)
  }

  const load = useCallback(async () => {
    const current = epoch.current
    try {
      const next = await sandboxSnapshotList(projectId)
      if (current === epoch.current) {
        setSnapshots(next)
        setError(null)
      }
    } catch {
      if (current === epoch.current) setError("load")
    } finally {
      if (current === epoch.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    epoch.current += 1
    inFlight.current = false
    const current = epoch.current
    void Promise.resolve().then(() => {
      if (current === epoch.current) return load()
    })
    return () => {
      epoch.current += 1
    }
  }, [load])

  const refresh = async () => {
    setLoading(true)
    await load()
  }

  const run = async (action: () => Promise<SandboxSnapshot | ForkedSandboxSnapshot>) => {
    if (inFlight.current) return
    const current = epoch.current
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (current !== epoch.current) return
      if ("snapshotId" in result)
        setSnapshots((previous) => [
          result,
          ...previous.filter((row) => row.snapshotId !== result.snapshotId),
        ])
      else setForked(result)
    } catch (cause) {
      if (current !== epoch.current) return
      const message =
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : JSON.stringify(cause)
      setError(
        message?.includes("snapshot_busy")
          ? "busy"
          : message?.includes("snapshot_budget_exceeded")
            ? "budget"
            : "action"
      )
    } finally {
      if (current === epoch.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return {
    snapshots,
    loading,
    busy,
    error,
    forked,
    refresh,
    create: (request: Omit<CreateSandboxSnapshot, "projectId">) =>
      run(() => sandboxSnapshotCreate({ ...request, projectId })),
    pin: (id: string, pinned: boolean) => run(() => sandboxSnapshotPin(id, pinned)),
    remove: (id: string) => run(() => sandboxSnapshotDelete(id)),
    fork: (id: string) =>
      run(() =>
        sandboxSnapshotFork({
          snapshotId: id,
          taskId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
        })
      ),
    restore: (id: string, workspaceId: string) =>
      run(() =>
        sandboxSnapshotRestore({
          snapshotId: id,
          workspaceId,
          taskId: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
        })
      ),
  }
}
