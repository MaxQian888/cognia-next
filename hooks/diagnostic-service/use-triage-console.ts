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
 *
 * Request discipline:
 *   - `enabled: false` (the Service channel is not on screen) issues nothing.
 *     The hook is mounted by the `/logs` shell for every channel, and used to
 *     list groups from a remote host while the user was reading local logs.
 *   - The free-text filters (search, assignee) are debounced by
 *     `TRIAGE_FILTER_DEBOUNCE_MS`; the status select applies at once. A
 *     request per keystroke against a self-hosted service is a load test.
 *   - A selected group that leaves the list (filtered out, deleted) is
 *     deselected, and `onSelectGroup(null)` is told, rather than leaving a
 *     detail pane for a row that is no longer there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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

/** How long the free-text filters wait for typing to stop. */
export const TRIAGE_FILTER_DEBOUNCE_MS = 300

export interface UseTriageConsoleOptions {
  client: DiagnosticServiceClient | null
  /** Whether the current grant satisfies a role. */
  can: (role: "viewer" | "triager" | "admin") => boolean
  /**
   * Whether the console may issue requests at all. Defaults to true; the
   * `/logs` shell passes `activeView === "service"`. While false nothing is
   * fetched and the last result stays in memory for when it comes back.
   */
  enabled?: boolean
  /** A group to open on, e.g. from a `?group=` deep link. Read once, at mount. */
  initialSelectedGroupId?: string | null
  /**
   * Told whenever the selection changes — by the user, or because the
   * selected group left the list. For a caller that mirrors it into the URL.
   */
  onSelectGroup?: (groupId: string | null) => void
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
  const { client, can, enabled = true, initialSelectedGroupId = null, onSelectGroup } = options
  const [filters, setFilters] = useState<TriageFilters>(DEFAULT_TRIAGE_FILTERS)
  // The text filters as last sent; `filters` is what the inputs show.
  const [queryText, setQueryText] = useState({
    search: DEFAULT_TRIAGE_FILTERS.search,
    assignedTo: DEFAULT_TRIAGE_FILTERS.assignedTo,
  })
  const [groups, setGroups] = useState<IncidentGroupRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialSelectedGroupId)
  const [detail, setDetail] = useState<GroupDetail | null>(null)
  const [incidentDetail, setIncidentDetail] = useState<IncidentDetailBundle | null>(null)
  const [tenant, setTenant] = useState<TenantRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)

  const readable = Boolean(client) && can("viewer")

  // Read inside the list continuation without re-running the list effect on
  // every selection. Written in an effect, never during render.
  const selectedRef = useRef(selectedGroupId)
  const onSelectGroupRef = useRef(onSelectGroup)
  useEffect(() => {
    selectedRef.current = selectedGroupId
    onSelectGroupRef.current = onSelectGroup
  }, [onSelectGroup, selectedGroupId])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  // Debounce the text filters. The write happens in the timer callback, not in
  // the effect body.
  useEffect(() => {
    if (filters.search === queryText.search && filters.assignedTo === queryText.assignedTo) return
    const timer = setTimeout(
      () => setQueryText({ search: filters.search, assignedTo: filters.assignedTo }),
      TRIAGE_FILTER_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [filters.assignedTo, filters.search, queryText.assignedTo, queryText.search])

  useEffect(() => {
    if (!enabled) return
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
    let current = true
    setLoadingSoon(setLoading)
    void client
      .listGroups({
        status: filters.status === "all" ? undefined : filters.status,
        q: queryText.search.trim() || undefined,
        assignedTo: queryText.assignedTo.trim() || undefined,
      })
      .then((result) => {
        if (!current) return
        setGroups(result)
        setErrorCode(null)
        const selected = selectedRef.current
        if (selected && !result.some((group) => group.id === selected)) {
          setSelectedGroupId(null)
          setIncidentDetail(null)
          onSelectGroupRef.current?.(null)
        }
      })
      .catch((cause: unknown) => {
        if (current) setErrorCode(codeOf(cause))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [client, enabled, filters.status, generation, queryText, readable])

  // Group detail: the group itself plus the incidents that fingerprinted into
  // it, which is what makes a group actionable rather than just a counter.
  useEffect(() => {
    if (!enabled) return
    if (!client || !selectedGroupId || !readable) {
      void Promise.resolve().then(() => setDetail(null))
      return
    }
    let current = true
    void Promise.all([
      client.getGroup(selectedGroupId),
      client.listIncidents({ groupId: selectedGroupId, limit: 50 }),
    ])
      .then(([group, incidents]) => {
        if (current) setDetail({ group, incidents })
      })
      .catch((cause: unknown) => {
        if (current) setErrorCode(codeOf(cause))
      })
    return () => {
      current = false
    }
  }, [client, enabled, readable, selectedGroupId, generation])

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
    onSelectGroupRef.current?.(groupId)
  }, [])

  // A group selected but not yet loaded (or filtered out) has no detail; the
  // detail shown is always the selected one's.
  const visibleDetail = detail && detail.group.id === selectedGroupId ? detail : null

  return useMemo(
    () => ({
      readable,
      enabled,
      filters,
      setFilters,
      groups,
      loading,
      busy,
      errorCode,
      selectedGroupId,
      selectGroup,
      detail: visibleDetail,
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
      downloadArtifact,
      enabled,
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
      visibleDetail,
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
