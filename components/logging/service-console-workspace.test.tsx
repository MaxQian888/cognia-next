/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { useTriageConsole } from "@/hooks/diagnostic-service/use-triage-console"
import type { IncidentGroupRecord, IncidentRecord } from "@/lib/diagnostic-service/types"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
}))

import { ServiceConsoleWorkspace, translatableConsoleCode } from "./service-console-workspace"

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

const incident = {
  id: "inc-1",
  supportCode: "ABC123",
  processingState: "accepted",
  createdAt: "2026-08-20T00:00:00.000Z",
} as unknown as IncidentRecord

type Console = ReturnType<typeof useTriageConsole>

function consoleState(over: Partial<Console> = {}): Console {
  return {
    readable: true,
    filters: { status: "open", search: "", assignedTo: "" },
    setFilters: jest.fn(),
    groups: [group],
    loading: false,
    busy: false,
    errorCode: null,
    selectedGroupId: null,
    selectGroup: jest.fn(),
    detail: null,
    incidentDetail: null,
    openIncident: jest.fn(),
    closeIncident: jest.fn(),
    downloadArtifact: jest.fn(),
    setStatus: jest.fn(),
    setAssignee: jest.fn(),
    tenant: null,
    loadTenant: jest.fn(),
    setRawMinidumpAccess: jest.fn(),
    refresh: jest.fn(),
    ...over,
  } as Console
}

function renderConsole(
  over: {
    console?: Partial<Console>
    configured?: boolean
    role?: "viewer" | "triager" | "admin" | "uploader"
    onConfigure?: () => void
  } = {}
) {
  const order = ["uploader", "viewer", "triager", "admin"]
  const role = over.role ?? "triager"
  const can = (required: "viewer" | "triager" | "admin") =>
    order.indexOf(role) >= order.indexOf(required)
  return render(
    <ServiceConsoleWorkspace
      console={consoleState(over.console)}
      configured={over.configured ?? true}
      can={can}
      onConfigure={over.onConfigure ?? jest.fn()}
    />
  )
}

describe("ServiceConsoleWorkspace", () => {
  it("offers a way out when no service is configured", async () => {
    const onConfigure = jest.fn()
    renderConsole({ configured: false, onConfigure })
    expect(screen.getByTestId("console-unconfigured")).toBeInTheDocument()
    await userEvent.click(screen.getByText("logging.workspace.console.configure"))
    expect(onConfigure).toHaveBeenCalled()
  })

  it("says the grant is too low rather than rendering an empty list", () => {
    // An empty group list reads as "no crashes"; a Viewer-less grant is a
    // different fact and has to look different.
    renderConsole({ console: { readable: false } })
    expect(screen.getByTestId("console-insufficient-role")).toBeInTheDocument()
    expect(screen.queryByTestId("console-group-list")).toBeNull()
  })

  it("lists groups with their status, volume and assignee", () => {
    renderConsole({
      console: {
        groups: [{ ...group, assignedTo: "ops@example.com", regressionCount: 2 }],
      },
    })
    expect(screen.getByText("panic · cognia-desktop")).toBeInTheDocument()
    expect(screen.getByText("fp-abc")).toBeInTheDocument()
    expect(screen.getByText("ops@example.com")).toBeInTheDocument()
    expect(
      screen.getByText('logging.workspace.console.groups.count:{"count":3}')
    ).toBeInTheDocument()
    expect(
      screen.getByText('logging.workspace.console.groups.regression:{"count":2}')
    ).toBeInTheDocument()
  })

  it("hides every triage control from a viewer", () => {
    renderConsole({
      role: "viewer",
      console: { selectedGroupId: group.id, detail: { group, incidents: [] } },
    })
    expect(screen.getByText("logging.workspace.console.group.readOnly")).toBeInTheDocument()
    expect(screen.queryByTestId("console-status-resolved")).toBeNull()
    expect(screen.queryByTestId("console-tenant-policy")).toBeNull()
  })

  it("moves a group between statuses", async () => {
    const setStatus = jest.fn()
    renderConsole({
      console: { selectedGroupId: group.id, detail: { group, incidents: [] }, setStatus },
    })
    await userEvent.click(screen.getByTestId("console-status-resolved"))
    expect(setStatus).toHaveBeenCalledWith("group-1", "resolved")
    // The status it already has is not offered as an action.
    expect(screen.getByTestId("console-status-open")).toBeDisabled()
  })

  it("assigns with a value and unassigns with an explicit null", async () => {
    const setAssignee = jest.fn()
    renderConsole({
      console: {
        selectedGroupId: group.id,
        detail: { group: { ...group, assignedTo: "ops@example.com" }, incidents: [] },
        setAssignee,
      },
    })
    await userEvent.type(
      screen.getByLabelText("logging.workspace.console.group.assignee"),
      "sre@example.com"
    )
    await userEvent.click(screen.getByText("logging.workspace.console.group.assign"))
    expect(setAssignee).toHaveBeenCalledWith("group-1", "sre@example.com")

    await userEvent.click(screen.getByTestId("console-unassign"))
    // Null, not "": the service treats an absent field as "leave alone".
    expect(setAssignee).toHaveBeenLastCalledWith("group-1", null)
  })

  it("does not offer unassign on a group nobody owns", () => {
    renderConsole({
      console: { selectedGroupId: group.id, detail: { group, incidents: [] } },
    })
    expect(screen.queryByTestId("console-unassign")).toBeNull()
  })

  it("opens an incident and shows its artifacts and audit trail", async () => {
    const openIncident = jest.fn()
    const { rerender } = renderConsole({
      console: {
        selectedGroupId: group.id,
        detail: { group, incidents: [incident] },
        openIncident,
      },
    })
    await userEvent.click(screen.getByTestId("console-incident-row"))
    expect(openIncident).toHaveBeenCalledWith("inc-1")

    rerender(
      <ServiceConsoleWorkspace
        console={consoleState({
          selectedGroupId: group.id,
          detail: { group, incidents: [incident] },
          incidentDetail: {
            incident,
            artifacts: [
              {
                incidentId: "inc-1",
                partNumber: 3,
                objectKey: "k",
                sourceSha256: "a",
                storedSha256: "b",
                storedBytes: 4096,
                redactionVersion: "server-v1",
                removedFields: [],
                artifactKind: "minidump",
                createdAt: "2026-08-20T00:00:00.000Z",
              },
            ],
            audit: [
              {
                id: 1,
                action: "artifact.read",
                incidentId: "inc-1",
                actorId: "ops@example.com",
                reason: null,
                details: {},
                occurredAt: "2026-08-20T01:00:00.000Z",
              },
              {
                id: 2,
                action: "incident.created",
                incidentId: "inc-1",
                actorId: null,
                reason: null,
                details: {},
                occurredAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          },
        })}
        configured
        can={() => true}
        onConfigure={jest.fn()}
      />
    )
    expect(screen.getByTestId("console-incident")).toBeInTheDocument()
    expect(screen.getByText(/#3 · minidump · 4096/)).toBeInTheDocument()
    expect(screen.getByText(/artifact\.read/)).toBeInTheDocument()
    // A worker action has no operator; it must not borrow one.
    expect(screen.getByText(/logging\.workspace\.console\.incident\.system/)).toBeInTheDocument()
  })

  it("never offers a raw artifact read to a viewer", () => {
    render(
      <ServiceConsoleWorkspace
        console={consoleState({
          selectedGroupId: group.id,
          detail: { group, incidents: [incident] },
          incidentDetail: {
            incident,
            artifacts: [
              {
                incidentId: "inc-1",
                partNumber: 1,
                objectKey: "k",
                sourceSha256: "a",
                storedSha256: "b",
                storedBytes: 10,
                redactionVersion: "server-v1",
                removedFields: [],
                artifactKind: "minidump",
                createdAt: "2026-08-20T00:00:00.000Z",
              },
            ],
            audit: [],
          },
        })}
        configured
        can={(role) => role === "viewer"}
        onConfigure={jest.fn()}
      />
    )
    expect(screen.queryByTestId("console-artifact-download")).toBeNull()
  })

  it("gates the tenant policy behind an admin grant", async () => {
    const setRawMinidumpAccess = jest.fn()
    renderConsole({
      role: "admin",
      console: {
        selectedGroupId: group.id,
        detail: { group, incidents: [] },
        tenant: {
          id: "t",
          name: "Tenant",
          retentionOverrides: {},
          rawMinidumpAccessEnabled: false,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        setRawMinidumpAccess,
      },
    })
    await userEvent.click(screen.getByLabelText("logging.workspace.console.policy.rawMinidump"))
    expect(setRawMinidumpAccess).toHaveBeenCalledWith(true)
  })

  it("translates a service error code and falls back for an unknown one", () => {
    const { unmount } = renderConsole({
      console: { errorCode: "raw_minidump_access_disabled" },
    })
    expect(screen.getByTestId("console-error")).toHaveTextContent(
      "logging.workspace.console.errors.raw_minidump_access_disabled"
    )
    unmount()
    renderConsole({ console: { errorCode: "a_code_from_a_newer_service" } })
    expect(screen.getByTestId("console-error")).toHaveTextContent(
      "logging.workspace.console.errors.console_failed"
    )
  })
})

describe("translatableConsoleCode", () => {
  it("passes known codes through and collapses the rest", () => {
    expect(translatableConsoleCode("group_not_found")).toBe("group_not_found")
    expect(translatableConsoleCode("something_new")).toBe("console_failed")
  })
})
