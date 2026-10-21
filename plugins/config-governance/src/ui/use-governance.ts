/**
 * The view's data: the active runtime, its status, and everything stored for
 * one workspace, reloaded whenever the runtime reports a change.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import type { CheckResult } from "../adherence/backtest"
import type { RuleCheck } from "../adherence/checks"
import type { EnforcementRule } from "../enforcement/rules"
import type { AuditRun, Finding } from "../model"
import { getActiveRuntime, subscribeActiveRuntime } from "../runtime/active"
import type { GovernanceRuntime, RuntimeStatus, WorkspaceInfo } from "../runtime/runtime"
import type {
  AppliedChange,
  EvalRecord,
  RunSummary,
  StoredAdherence,
  StoredChecks,
} from "../runtime/store"

export function useActiveRuntime(): GovernanceRuntime | null {
  return useSyncExternalStore(subscribeActiveRuntime, getActiveRuntime, getActiveRuntime)
}

const IDLE: RuntimeStatus = { revision: 0 }

export function useRuntimeStatus(runtime: GovernanceRuntime | null): RuntimeStatus {
  const subscribe = useCallback(
    (listener: () => void) => (runtime ? runtime.subscribe(listener) : () => {}),
    [runtime]
  )
  const read = useCallback(() => (runtime ? runtime.getStatus() : IDLE), [runtime])
  return useSyncExternalStore(subscribe, read, read)
}

export interface GovernanceData {
  run?: AuditRun
  findings: Finding[]
  kept: Set<string>
  checks?: StoredChecks
  adherence?: StoredAdherence
  results: Map<string, CheckResult>
  checksById: Map<string, RuleCheck>
  rules: EnforcementRule[]
  applied: AppliedChange[]
  evals: EvalRecord[]
  history: RunSummary[]
  falseMatches: Set<string>
  /** The model the latest audit judged for, when the default has changed since. */
  modelChangedFrom?: string
}

export type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: GovernanceData; workspaceId: string | null }
  | { status: "error"; message: string }

async function load(
  runtime: GovernanceRuntime,
  workspaceId: string | null
): Promise<GovernanceData> {
  const store = runtime.store
  const [
    run,
    findings,
    kept,
    checks,
    adherence,
    rules,
    applied,
    evals,
    history,
    falseMatches,
    modelChangedFrom,
  ] = await Promise.all([
    store.latestRun(workspaceId),
    runtime.findings(workspaceId),
    store.keptFindings(workspaceId),
    store.checks(workspaceId),
    store.adherence(workspaceId),
    store.rules(),
    store.appliedChanges(),
    store.evalRecords(),
    store.history(workspaceId),
    store.falseMatches(),
    runtime.modelChangedSince(workspaceId),
  ])
  return {
    ...(run ? { run } : {}),
    findings,
    kept,
    ...(checks ? { checks } : {}),
    ...(adherence ? { adherence } : {}),
    results: new Map((adherence?.results ?? []).map((result) => [result.checkId, result])),
    checksById: new Map((checks?.checks ?? []).map((check) => [check.id, check])),
    rules,
    applied: applied.filter((change) => change.workspaceId === workspaceId),
    evals: evals.filter((record) => record.workspaceId === workspaceId),
    history,
    falseMatches,
    ...(modelChangedFrom ? { modelChangedFrom } : {}),
  }
}

export function useGovernanceData(
  runtime: GovernanceRuntime | null,
  workspaceId: string | null | undefined,
  revision: number
): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  useEffect(() => {
    if (!runtime || workspaceId === undefined) return
    let cancelled = false
    load(runtime, workspaceId).then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data, workspaceId })
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
      }
    )
    return () => {
      cancelled = true
    }
  }, [runtime, workspaceId, revision])
  return state
}

export function useWorkspaces(runtime: GovernanceRuntime | null): {
  workspaces: WorkspaceInfo[]
  initial: string | null | undefined
} {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [initial, setInitial] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    void Promise.all([runtime.workspaces(), runtime.defaultWorkspace()]).then(
      ([list, preferred]) => {
        if (cancelled) return
        setWorkspaces(list)
        setInitial(preferred && list.some((entry) => entry.id === preferred) ? preferred : null)
      },
      () => {
        if (!cancelled) setInitial(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [runtime])
  return { workspaces, initial }
}
