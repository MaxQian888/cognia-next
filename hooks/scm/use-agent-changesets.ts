"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AppSettings } from "@cognia/agent-config-types"
import { normalizeFsPath } from "@/lib/files/permissions"
import { createScmHost, scmErrorCode, type ScmHost } from "@/lib/scm/host"
import type { IntegrateChangesetsInput } from "@/lib/scm/integration/orchestrator"
import { approveChangeset, requestChangesetChanges } from "@/lib/scm/review/review-changeset"
import type { AgentChangeset, IntegrationRun } from "@/lib/scm/types"

interface Options {
  rootDir: string
  projectId: string | null
  appSettings: AppSettings | null | undefined
  host?: ScmHost
}

/** Host records are authoritative; stale reads and departed repositories cannot replace them. */
export function useAgentChangesets({
  rootDir,
  projectId,
  appSettings,
  host: injectedHost,
}: Options) {
  const host = useMemo(() => injectedHost ?? createScmHost(), [injectedHost])
  const scope = useMemo(() => ({ rootDir, host }), [rootDir, host])
  const lifecycle = useRef<{
    scope: typeof scope
    active: boolean
    request: number
    operation: AbortController | null
  } | null>(null)
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope
    changesets: AgentChangeset[]
    integrations: IntegrationRun[]
    loading: boolean
  }>({ scope, changesets: [], integrations: [], loading: true })
  const [failure, setFailure] = useState<{
    scope: typeof scope
    kind: "load" | "action"
    code: string | null
  } | null>(null)
  const [pendingScope, setPendingScope] = useState<typeof scope | null>(null)

  const refresh = useCallback(async () => {
    const session = lifecycle.current
    if (!session?.active || session.scope !== scope) return
    const request = ++session.request
    setSnapshot((previous) =>
      previous.scope === scope
        ? { ...previous, loading: true }
        : { scope, changesets: [], integrations: [], loading: true }
    )
    try {
      const [allChangesets, allIntegrations] = await Promise.all([
        host.listChangesets(),
        host.listIntegrations(),
      ])
      if (!session.active || request !== session.request) return
      const root = normalizeFsPath(rootDir)
      const changesets = allChangesets.filter(
        (item) => root && normalizeFsPath(item.sourceRoot) === root
      )
      const repos = new Set(changesets.map((item) => normalizeFsPath(item.repoCommonDir)))
      setSnapshot({
        scope,
        changesets,
        integrations: allIntegrations.filter((run) =>
          repos.has(normalizeFsPath(run.repoCommonDir))
        ),
        loading: false,
      })
      setFailure((previous) =>
        previous?.scope === scope && previous.kind === "action" ? previous : null
      )
    } catch (error) {
      if (!session.active || request !== session.request) return
      setFailure({ scope, kind: "load", code: scmErrorCode(error) })
      setSnapshot((previous) => ({ ...previous, loading: false }))
    }
  }, [host, rootDir, scope])

  useEffect(() => {
    const session = { scope, active: true, request: 0, operation: null as AbortController | null }
    lifecycle.current = session
    void Promise.resolve().then(refresh)
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      session.active = false
      session.request += 1
      session.operation?.abort()
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh, scope])

  const mutate = useCallback(
    async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
      const session = lifecycle.current
      if (!session?.active || session.scope !== scope || session.operation) return null
      const controller = new AbortController()
      session.operation = controller
      setPendingScope(scope)
      setFailure(null)
      try {
        return await operation(controller.signal)
      } catch (error) {
        if (session.active) setFailure({ scope, kind: "action", code: scmErrorCode(error) })
        return null
      } finally {
        if (session.active) {
          // Even a failed multi-step action may have recorded review/check evidence.
          await refresh()
          if (session.active) setPendingScope(null)
        }
        session.operation = null
      }
    },
    [refresh, scope]
  )

  const review = useCallback(
    (id: string) =>
      mutate(async (signal) => {
        const { createScmRuntime } = await import("@/lib/scm/runtime")
        if (signal.aborted) return null
        return createScmRuntime({ projectId, appSettings, host }).review(id, signal)
      }),
    [appSettings, host, mutate, projectId]
  )
  const integrate = useCallback(
    (input: Omit<IntegrateChangesetsInput, "signal">) =>
      mutate(async (signal) => {
        const { createScmRuntime } = await import("@/lib/scm/runtime")
        if (signal.aborted) return null
        return createScmRuntime({ projectId, appSettings, host }).integrate({ ...input, signal })
      }),
    [appSettings, host, mutate, projectId]
  )

  return {
    host,
    changesets: snapshot.scope === scope ? snapshot.changesets : [],
    integrations: snapshot.scope === scope ? snapshot.integrations : [],
    loading: snapshot.scope !== scope || snapshot.loading,
    error: failure?.scope === scope ? failure : null,
    busy: pendingScope === scope,
    refresh,
    review,
    integrate,
    approve: (changeset: AgentChangeset) => mutate(() => approveChangeset(host, changeset, "user")),
    requestChanges: (changeset: AgentChangeset, note: string) =>
      mutate(() => requestChangesetChanges(host, changeset, note)),
    abandon: (id: string) => mutate(() => host.abandonChangeset(id)),
    rollback: (id: string) => mutate(() => host.rollbackIntegration(id)),
    abort: (id: string) => mutate(() => host.abortIntegration(id)),
  }
}

export type AgentChangesActions = ReturnType<typeof useAgentChangesets>
