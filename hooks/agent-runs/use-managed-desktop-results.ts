"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getDb } from "@/lib/db/schema"
import { deleteManagedDesktopAcceptanceRouted } from "@/lib/chat/session-archive-writes"
import { syncManagedDesktopAcceptanceResult } from "@/lib/execution/managed-desktop-results"
import {
  createManagedDesktopResultsScope,
  managedDesktopEvidenceUrl,
  type ManagedDesktopAcceptanceResult,
  type ManagedDesktopResultsFilter,
} from "@/lib/automation/managed-desktop-results-client"

type Scope = ReturnType<typeof createManagedDesktopResultsScope>

/** Durable Host reads survive journal pruning; images exist only for this mounted identity. */
export function useManagedDesktopResults(filter: ManagedDesktopResultsFilter) {
  const [records, setRecords] = useState<ManagedDesktopAcceptanceResult[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const scopeRef = useRef<Scope | null>(null)
  const urls = useRef(new Map<string, string>())
  const epoch = useRef(0)
  const pending = useRef<symbol | null>(null)
  const activeFilter = useRef<string | null>(null)
  const approvalKeys = useRef(new Map<string, string>())
  const { runId, conversationId, taskId } = filter
  const filterKey = JSON.stringify([runId, conversationId, taskId])
  const [stateFilter, setStateFilter] = useState(filterKey)
  // Reset before rendering a new history scope, rather than waiting for its
  // first asynchronous Host read while the previous result remains actionable.
  if (stateFilter !== filterKey) {
    setStateFilter(filterKey)
    setRecords([])
    setPreviews({})
    setLoading(true)
    setError(false)
    setBusy(false)
  }
  const clearPreviews = useCallback(() => {
    urls.current.forEach((url) => URL.revokeObjectURL(url))
    urls.current.clear()
  }, [])
  useEffect(() => {
    let alive = true
    activeFilter.current = filterKey
    let timer: ReturnType<typeof setTimeout> | undefined
    const db = getDb()
    const invalidate = () => {
      epoch.current += 1
      pending.current = null
      clearPreviews()
      if (alive) {
        setRecords([])
        setPreviews({})
        setError(true)
        setLoading(false)
        setBusy(false)
      }
    }
    let scope: Scope
    try {
      scope = createManagedDesktopResultsScope(invalidate)
    } catch {
      queueMicrotask(invalidate)
      return () => {
        alive = false
      }
    }
    scopeRef.current = scope
    const deleted = () => invalidate()
    window.addEventListener("cognia:managed-desktop-results-deleted", deleted)
    const load = async () => {
      const generation = epoch.current
      try {
        const received = await scope.list({ runId, conversationId, taskId })
        if (!alive || generation !== epoch.current) return
        const next: ManagedDesktopAcceptanceResult[] = []
        for (const record of received) {
          if (await syncManagedDesktopAcceptanceResult(record, scope, db)) next.push(record)
        }
        scope.assertActive()
        if (!alive || generation !== epoch.current) return
        const retained = new Set(
          next.flatMap((record) =>
            record.artifacts.map((artifact) => `${record.binding.acceptanceId}:${artifact.id}`)
          )
        )
        urls.current.forEach((url, id) => {
          if (!retained.has(id)) {
            URL.revokeObjectURL(url)
            urls.current.delete(id)
          }
        })
        setPreviews(Object.fromEntries(urls.current))
        setRecords((current) =>
          next.map((record) => {
            const previous = current.find(
              (item) => item.binding.acceptanceId === record.binding.acceptanceId
            )
            return previous &&
              Math.max(0, ...previous.humanApprovals.map((item) => item.revision)) >
                Math.max(0, ...record.humanApprovals.map((item) => item.revision))
              ? previous
              : record
          })
        )
        setError(false)
      } catch {
        if (alive) {
          clearPreviews()
          setPreviews({})
          setRecords([])
          setError(true)
        }
      } finally {
        if (alive) {
          setLoading(false)
          timer = setTimeout(() => void load(), 3000)
        }
      }
    }
    void load()
    return () => {
      alive = false
      epoch.current += 1
      if (timer) clearTimeout(timer)
      window.removeEventListener("cognia:managed-desktop-results-deleted", deleted)
      scopeRef.current = null
      activeFilter.current = null
      pending.current = null
      scope.dispose()
      clearPreviews()
    }
  }, [runId, conversationId, taskId, filterKey, clearPreviews])

  const viewEvidence = async (result: ManagedDesktopAcceptanceResult, artifactId: string) => {
    const scope = scopeRef.current
    if (!scope || pending.current || activeFilter.current !== filterKey) return
    const artifact = result.artifacts.find((item) => item.id === artifactId)
    if (!artifact) return
    const key = `${result.binding.acceptanceId}:${artifactId}`
    if (urls.current.has(key)) return
    const generation = epoch.current
    const request = Symbol()
    pending.current = request
    setBusy(true)
    let url: string | undefined
    try {
      const response = await scope.readEvidence(result.binding.acceptanceId, artifactId)
      url = await managedDesktopEvidenceUrl(artifact, response)
      scope.assertActive()
      if (generation !== epoch.current || scopeRef.current !== scope) return
      urls.current.set(key, url)
      url = undefined
      setPreviews(Object.fromEntries(urls.current))
    } catch {
      if (generation === epoch.current) setError(true)
    } finally {
      if (url) URL.revokeObjectURL(url)
      if (pending.current === request) pending.current = null
      if (generation === epoch.current) setBusy(false)
    }
  }
  const approve = async (
    result: ManagedDesktopAcceptanceResult,
    decision: "approved" | "rejected"
  ) => {
    const scope = scopeRef.current
    if (!scope || pending.current || activeFilter.current !== filterKey) return
    const generation = epoch.current
    const revision = Math.max(0, ...result.humanApprovals.map((item) => item.revision))
    const key = `${result.binding.acceptanceId}:${revision}:${decision}`
    let idempotencyKey = approvalKeys.current.get(key)
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID()
      approvalKeys.current.set(key, idempotencyKey)
    }
    const request = Symbol()
    pending.current = request
    setBusy(true)
    try {
      const next = await scope.approve(
        result.binding.acceptanceId,
        revision,
        decision,
        idempotencyKey
      )
      if (generation === epoch.current && scopeRef.current === scope)
        setRecords((current) =>
          current.map((item) =>
            item.binding.acceptanceId === next.binding.acceptanceId &&
            Math.max(0, ...item.humanApprovals.map((approval) => approval.revision)) <=
              Math.max(0, ...next.humanApprovals.map((approval) => approval.revision))
              ? next
              : item
          )
        )
    } catch {
      if (generation === epoch.current) setError(true)
    } finally {
      if (pending.current === request) pending.current = null
      if (generation === epoch.current) setBusy(false)
    }
  }
  const remove = async (result: ManagedDesktopAcceptanceResult) => {
    const scope = scopeRef.current
    if (!scope || pending.current || activeFilter.current !== filterKey) return
    const request = Symbol()
    pending.current = request
    setBusy(true)
    try {
      scope.assertActive()
      await deleteManagedDesktopAcceptanceRouted(
        result.binding.acceptanceId,
        result.binding.sessionId
      )
    } catch {
      if (scopeRef.current === scope) setError(true)
    } finally {
      if (pending.current === request) pending.current = null
      if (scopeRef.current === scope) setBusy(false)
    }
  }
  return { records, previews, error, loading, busy, viewEvidence, approve, remove }
}
