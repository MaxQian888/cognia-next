import { act, renderHook, waitFor } from "@testing-library/react"

import type { DiagnosticServiceClient } from "@/lib/diagnostic-service/client"
import type { IncidentGroupRecord } from "@/lib/diagnostic-service/types"

import { DEFAULT_TRIAGE_FILTERS, useTriageConsole } from "./use-triage-console"

const group: IncidentGroupRecord = {
  id: "group-1",
  projectId: "project-1",
  fingerprint: "fp-abc",
  fingerprintVersion: "fingerprint-v1",
  status: "open",
  assignedTo: null,
  regressionCount: 0,
  compatibleBuildFamily: "1.2",
  platform: "macos",
  exception: "panic",
  module: "cognia-desktop",
  topFrames: [],
  incidentCount: 3,
  firstSeenAt: "2026-08-19T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:00:00.000Z",
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
}

function stubClient(over: Partial<Record<keyof DiagnosticServiceClient, unknown>> = {}) {
  return {
    listGroups: jest.fn(async () => [group]),
    getGroup: jest.fn(async () => group),
    listIncidents: jest.fn(async () => []),
    getIncident: jest.fn(async () => ({ id: "inc-1" })),
    listArtifacts: jest.fn(async () => []),
    incidentAudit: jest.fn(async () => []),
    downloadArtifact: jest.fn(async () => new Uint8Array([1, 2])),
    triageGroup: jest.fn(async () => group),
    getTenant: jest.fn(async () => ({ rawMinidumpAccessEnabled: false })),
    updateTenant: jest.fn(async () => ({ rawMinidumpAccessEnabled: true })),
    ...over,
  } as unknown as DiagnosticServiceClient
}

const allow = () => true

describe("useTriageConsole", () => {
  it("stays inert without a client", async () => {
    const { result } = renderHook(() => useTriageConsole({ client: null, can: allow }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.readable).toBe(false)
    expect(result.current.groups).toEqual([])
  })

  it("refuses to read for a grant below viewer", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: () => false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.readable).toBe(false)
    expect(client.listGroups).not.toHaveBeenCalled()
  })

  it("opens on the open groups rather than everything ever recorded", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    expect(DEFAULT_TRIAGE_FILTERS.status).toBe("open")
    expect(client.listGroups).toHaveBeenCalledWith({
      status: "open",
      q: undefined,
      assignedTo: undefined,
    })
  })

  it("drops blank filters instead of sending empty strings", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.setFilters({ status: "all", search: "  ", assignedTo: "  ops  " }))
    await waitFor(() =>
      expect(client.listGroups).toHaveBeenLastCalledWith({
        status: undefined,
        q: undefined,
        assignedTo: "ops",
      })
    )
  })

  it("loads a group with the incidents that fingerprinted into it", async () => {
    const client = stubClient({ listIncidents: jest.fn(async () => [{ id: "inc-1" }]) })
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.selectGroup("group-1"))
    await waitFor(() => expect(result.current.detail?.group.id).toBe("group-1"))
    expect(client.listIncidents).toHaveBeenCalledWith({ groupId: "group-1", limit: 50 })
  })

  it("re-reads the list after a triage edit so the row reflects it", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    const before = (client.listGroups as jest.Mock).mock.calls.length

    act(() => result.current.setStatus("group-1", "resolved"))
    await waitFor(() =>
      expect(client.triageGroup).toHaveBeenCalledWith("group-1", { status: "resolved" })
    )
    await waitFor(() =>
      expect((client.listGroups as jest.Mock).mock.calls.length).toBeGreaterThan(before)
    )
  })

  it("carries an unassign through as an explicit null", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.setAssignee("group-1", null))
    await waitFor(() =>
      expect(client.triageGroup).toHaveBeenCalledWith("group-1", { assignedTo: null })
    )
  })

  it("surfaces the service's code rather than a generic failure", async () => {
    const client = stubClient({
      listGroups: jest.fn(() => Promise.reject({ code: "insufficient_grant_scope" })),
    })
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.errorCode).toBe("insufficient_grant_scope"))
  })

  it("refuses a raw artifact read below triager and returns nothing", async () => {
    const client = stubClient()
    const { result } = renderHook(() =>
      useTriageConsole({ client, can: (role) => role === "viewer" })
    )
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    await act(async () => {
      await expect(result.current.downloadArtifact("inc-1", 1)).resolves.toBeNull()
    })
    expect(client.downloadArtifact).not.toHaveBeenCalled()
  })

  it("reports a refused minidump read as the tenant policy it is", async () => {
    const client = stubClient({
      downloadArtifact: jest.fn(() => Promise.reject({ code: "raw_minidump_access_disabled" })),
    })
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    await act(async () => {
      await result.current.downloadArtifact("inc-1", 3)
    })
    expect(result.current.errorCode).toBe("raw_minidump_access_disabled")
  })

  it("only touches tenant policy with an admin grant", async () => {
    const client = stubClient()
    const { result } = renderHook(() =>
      useTriageConsole({ client, can: (role) => role !== "admin" })
    )
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.loadTenant())
    await waitFor(() => expect(result.current.errorCode).toBe("console_failed"))
    expect(client.getTenant).not.toHaveBeenCalled()
  })

  it("keeps the tenant record it just wrote rather than re-reading it", async () => {
    const client = stubClient()
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.setRawMinidumpAccess(true))
    await waitFor(() => expect(result.current.tenant?.rawMinidumpAccessEnabled).toBe(true))
    expect(client.updateTenant).toHaveBeenCalledWith({ rawMinidumpAccessEnabled: true })
  })

  it("clears an open incident when the selected group changes", async () => {
    const client = stubClient({ listIncidents: jest.fn(async () => [{ id: "inc-1" }]) })
    const { result } = renderHook(() => useTriageConsole({ client, can: allow }))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))
    act(() => result.current.selectGroup("group-1"))
    await act(async () => {
      result.current.openIncident("inc-1")
    })
    await waitFor(() => expect(result.current.incidentDetail).not.toBeNull())
    await act(async () => {
      result.current.selectGroup("group-2")
      // The group-detail fetch for the new selection is in flight; letting it
      // settle inside `act` keeps the assertion about the cleared incident
      // rather than about a pending render.
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.incidentDetail).toBeNull())
  })
})
