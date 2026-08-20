"use client"

/**
 * Data for the triage console.
 *
 * The service has grouped crashes by fingerprint since its grouping pipeline
 * shipped, but nothing ever read `incident_groups` back — so `status` never
 * left `open`, `assigned_to` was never anything but NULL, and an operator's
 * only view of a submitted crash was the support code the reporter quoted at
 * them. This hook is the read side that was missing.
 *
 * Every request is role-gated server-side (Viewer reads, Triager edits, Admin
 * for tenant policy), so the surface asks `can()` first and hides what this
 * operator may not use rather than discovering it through a wall of 403s.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import type { DiagnosticServiceClient } from "@/lib/diagnostic-service/client"
import type {
  AuditEventRecord,
  GroupStatus,
  IncidentGroupRecord,
  IncidentRecord,
  TenantRecord,
  UploadPartRecord,
} from "@/lib/diagnostic-service/types"

export interface TriageFilters {
  status: GroupStatus | "all"
  search: string
  /** Only groups assigned to this identity; empty means every group. */
  assignedTo: string
}

export const DEFAULT_TRIAGE_FILTERS: TriageFilters = {
  status: "open",
  search: "",
  assignedTo: "",
}

export interface GroupDetail {
  group: IncidentGroupRecord
  incidents: IncidentRecord[]
}

export interface IncidentDetailBundle {
  incident: IncidentRecord
  artifacts: UploadPartRecord[]
  audit: AuditEventRecord[]
}

export interface UseTriageConsoleOptions {
  client: DiagnosticServiceClient | null
  /** Whether the current grant satisfies a role. */
  can: (role: "viewer" | "triager" | "admin") => boolean
}

/** Errors arrive carrying the service's code; the UI translates it. */
function codeOf(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return "console_failed"
}

export function useTriageConsole(options: UseTriageConsoleOptions) {
  const { client, can } = options
  const [filters, setFilters] = useState<TriageFilters>(DEFAULT_TRIAGE_FILTERS)
  const [groups, setGroups] = useState<IncidentGroupRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [incidentDetail, setIncidentDetail] = useState<IncidentDetailBundle | null>(null)
  const [tenant, setTenant] = useState<TenantRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)

  const readable = Boolean(client) && can("viewer")

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!client || !readable) {
      // No synchronous setState in the effect body — the async continuation
      // owns every write, which is also what `react-hooks/set-state-in-effect`
      // requires.
      void Promise.resolve().then(() => {
        setGroups([])
        setLoading(false)
      })
      return
    }
    let active = true
    setLoadingSoon(setLoading)
    void client
      .listGroups({
        status: filters.status === "all" ? undefined : filters.status,
        q: filters.search.trim() || undefined,
        assignedTo: filters.assignedTo.trim() || undefined,
      })
      .then((result) => {
        if (!active) return
        setGroups(result)
        setErrorCode(null)
      })
      .catch((cause: unknown) => {
        if (active) setErrorCode(codeOf(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, filters, generation, readable])

  // Group detail: the group itself plus the incidents that fingerprinted into
  // it, which is what makes a group actionable rather than just a counter.
  useEffect(() => {
    if (!client || !selectedGroupId || !readable) {
      void Promise.resolve().then(() => setDetail(null))
      return
    }
    let active = true
    void Promise.all([
      client.getGroup(selectedGroupId),
      client.listIncidents({ groupId: selectedGroupId, limit: 50 }),
    ])
      .then(([group, incidents]) => {
        if (active) setDetail({ group, incidents })
      })
      .catch((cause: unknown) => {
        if (active) setErrorCode(codeOf(cause))
      })
    return () => {
      active = false
    }
  }, [client, readable, selectedGroupId, generation])

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true)
      setErrorCode(null)
      try {
        await action()
        refresh()
      } catch (cause) {
        setErrorCode(codeOf(cause))
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const setStatus = useCallback(
    (groupId: string, status: GroupStatus) =>
      void run(async () => {
        if (!client) throw new Error("not_connected")
        await client.triageGroup(groupId, { status })
      }),
    [client, run]
  )

  /**
   * Assign, or unassign with `null`.
   *
   * The null is carried all the way to the PATCH body: an absent field means
   * "leave the assignee alone", and collapsing the two would make unassigning
   * impossible to express.
   */
  const setAssignee = useCallback(
    (groupId: string, assignedTo: string | null) =>
      void run(async () => {
        if (!client) throw new Error("not_connected")
        await client.triageGroup(groupId, { assignedTo })
      }),
    [client, run]
  )

  const openIncident = useCallback(
    (incidentId: string) =>
      void run(async () => {
        if (!client) throw new Error("not_connected")
        const [incident, artifacts, audit] = await Promise.all([
          client.getIncident(incidentId),
          client.listArtifacts(incidentId),
          client.incidentAudit(incidentId, 50),
        ])
        setIncidentDetail({ incident, artifacts, audit })
      }),
    [client, run]
  )

  const closeIncident = useCallback(() => setIncidentDetail(null), [])

  /**
   * Pull one stored artifact back.
   *
   * Triager-only, and minidumps additionally require the tenant's
   * `rawMinidumpAccessEnabled` opt-in — the service answers
   * `raw_minidump_access_disabled` otherwise, and every successful read is
   * written to the incident's audit trail against the operator's identity.
   */
  const downloadArtifact = useCallback(
    async (incidentId: string, partNumber: number): Promise<Uint8Array | null> => {
      if (!client || !can("triager")) return null
      setBusy(true)
      setErrorCode(null)
      try {
        return await client.downloadArtifact(incidentId, partNumber)
      } catch (cause) {
        setErrorCode(codeOf(cause))
        return null
      } finally {
        setBusy(false)
      }
    },
    [can, client]
  )

  const loadTenant = useCallback(
    () =>
      void run(async () => {
        if (!client || !can("admin")) throw new Error("insufficient_grant_scope")
        setTenant(await client.getTenant())
      }),
    [can, client, run]
  )

  const setRawMinidumpAccess = useCallback(
    (enabled: boolean) =>
      void run(async () => {
        if (!client || !can("admin")) throw new Error("insufficient_grant_scope")
        setTenant(await client.updateTenant({ rawMinidumpAccessEnabled: enabled }))
      }),
    [can, client, run]
  )

  const selectGroup = useCallback((groupId: string | null) => {
    setSelectedGroupId(groupId)
    setIncidentDetail(null)
  }, [])

  return useMemo(
    () => ({
      readable,
      filters,
      setFilters,
      groups,
      loading,
      busy,
      errorCode,
      selectedGroupId,
      selectGroup,
      detail,
      incidentDetail,
      openIncident,
      closeIncident,
      downloadArtifact,
      setStatus,
      setAssignee,
      tenant,
      loadTenant,
      setRawMinidumpAccess,
      refresh,
    }),
    [
      busy,
      closeIncident,
      detail,
      downloadArtifact,
      errorCode,
      filters,
      groups,
      incidentDetail,
      loadTenant,
      loading,
      openIncident,
      readable,
      refresh,
      selectGroup,
      selectedGroupId,
      setAssignee,
      setRawMinidumpAccess,
      setStatus,
      tenant,
    ]
  )
}

/**
 * Flip the loading flag off the effect body.
 *
 * `setLoading(true)` inline is exactly what `react-hooks/set-state-in-effect`
 * blocks, and the cascading render it warns about is real: the list re-renders
 * once for the flag and again for the result.
 */
function setLoadingSoon(setLoading: (value: boolean) => void): void {
  void Promise.resolve().then(() => setLoading(true))
}
