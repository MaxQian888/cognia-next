/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { useTriageConsole } from "@/hooks/diagnostic-service/use-triage-console"
import type { IncidentGroupRecord, IncidentRecord } from "@/lib/diagnostic-service/types"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${namespace}.${key}:${JSON.stringify(vars)}` : `${namespace}.${key}`,
  useFormatter: () => ({
    dateTime: (value: Date) => value.toISOString(),
    number: (value: number, options?: { unit?: string }) =>
      options?.unit ? `${value} ${options.unit}` : String(value),
  }),
}))

// The detail is a pane at xl and a sheet below it, chosen in JS.
let wide = true
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useMediaQuery: () => wide,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const downloadBlobMock = jest.fn(async (_blob: Blob, _name: string) => ({ kind: "downloaded" }))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (blob: Blob, name: string) => downloadBlobMock(blob, name),
}))

import {
  artifactFilename,
  ServiceConsoleWorkspace,
  translatableConsoleCode,
} from "./service-console-workspace"

beforeEach(() => {
  wide = true
  toastSuccess.mockClear()
  toastError.mockClear()
  downloadBlobMock.mockClear()
})

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
    authenticated?: boolean
    loading?: boolean
    roleStatus?: "unknown" | "probing" | "known" | "failed"
    roleErrorCode?: string | null
    onRetryRole?: () => void
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
      authenticated={over.authenticated ?? true}
      loading={over.loading ?? false}
      roleStatus={over.roleStatus ?? "known"}
      roleErrorCode={over.roleErrorCode ?? null}
      onRetryRole={over.onRetryRole}
      can={can}
      onConfigure={over.onConfigure ?? jest.fn()}
    />
  )
}

const minidumpPart = {
  incidentId: "inc-1",
  partNumber: 3,
  objectKey: "k",
  sourceSha256: "a",
  storedSha256: "b",
  storedBytes: 4096,
  redactionVersion: "server-v1",
  removedFields: [],
  artifactKind: "minidump" as const,
  createdAt: "2026-08-20T00:00:00.000Z",
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
        authenticated
        loading={false}
        can={() => true}
        onConfigure={jest.fn()}
      />
    )
    expect(screen.getByTestId("console-incident")).toBeInTheDocument()
    // Kind and size are translated and carry a unit.
    expect(
      screen.getByText(
        'logging.workspace.console.incident.part:{"number":3,"kind":"logging.workspace.console.artifactKinds.minidump","size":"4 kilobyte"}'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByText(/logging\.workspace\.console\.auditActions\.artifact_read/)
    ).toBeInTheDocument()
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
        authenticated
        loading={false}
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
    // Tenant-wide: nothing changes until the dialog is confirmed.
    expect(setRawMinidumpAccess).not.toHaveBeenCalled()
    const dialog = within(await screen.findByTestId("console-raw-minidump-confirm"))
    expect(
      dialog.getByText("logging.workspace.console.policy.confirmEnableTitle")
    ).toBeInTheDocument()
    await userEvent.click(
      dialog.getByRole("button", { name: "logging.workspace.console.policy.confirmEnable" })
    )
    expect(setRawMinidumpAccess).toHaveBeenCalledWith(true)
  })

  it("lets an admin back out of the raw minidump switch", async () => {
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
          rawMinidumpAccessEnabled: true,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        setRawMinidumpAccess,
      },
    })
    await userEvent.click(screen.getByLabelText("logging.workspace.console.policy.rawMinidump"))
    const dialog = within(await screen.findByTestId("console-raw-minidump-confirm"))
    expect(
      dialog.getByText("logging.workspace.console.policy.confirmDisableTitle")
    ).toBeInTheDocument()
    await userEvent.click(
      dialog.getByRole("button", { name: "logging.workspace.console.policy.cancel" })
    )
    expect(setRawMinidumpAccess).not.toHaveBeenCalled()
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

describe("ServiceConsoleWorkspace gates", () => {
  it("shows a loading state while the connection is read", () => {
    renderConsole({ loading: true })
    expect(screen.getByTestId("console-loading")).toHaveTextContent(
      "logging.workspace.console.gates.loading"
    )
    expect(screen.queryByTestId("console-insufficient-role")).toBeNull()
  })

  it("shows a loading state while the role is probed, never 'insufficient role'", () => {
    // A fresh connection has a null role until its first grant exchange; that
    // used to read as "below Viewer".
    renderConsole({ roleStatus: "probing", console: { readable: false } })
    expect(screen.getByTestId("console-loading")).toHaveTextContent(
      "logging.workspace.console.gates.probing"
    )
    expect(screen.queryByTestId("console-insufficient-role")).toBeNull()
  })

  it("asks for an identity session when the connection has none", async () => {
    const onConfigure = jest.fn()
    renderConsole({ authenticated: false, roleStatus: "unknown", onConfigure })
    expect(screen.getByTestId("console-session-required")).toBeInTheDocument()
    await userEvent.click(screen.getByText("logging.workspace.console.configure"))
    expect(onConfigure).toHaveBeenCalled()
  })

  it("says the role could not be confirmed, and retries on demand", async () => {
    const onRetryRole = jest.fn()
    renderConsole({
      roleStatus: "failed",
      roleErrorCode: "invalid_oidc_session",
      onRetryRole,
      console: { readable: false },
    })
    const gate = screen.getByTestId("console-role-failed")
    expect(gate).toHaveTextContent("logging.workspace.console.errors.invalid_oidc_session")
    await userEvent.click(screen.getByText("logging.workspace.console.gates.retry"))
    expect(onRetryRole).toHaveBeenCalled()
  })
})

describe("ServiceConsoleWorkspace detail", () => {
  it("renders the resizable pane at xl and no sheet", async () => {
    renderConsole({ console: { selectedGroupId: group.id, detail: { group, incidents: [] } } })
    expect(screen.getByTestId("console-detail-pane")).toBeInTheDocument()
    expect(
      screen.getByRole("separator", { name: "logging.workspace.console.detail.resize" })
    ).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("console-group-row"))
    expect(screen.queryByTestId("console-detail-drawer")).toBeNull()
  })

  it("falls back to a sheet below xl, opened by choosing a group", async () => {
    wide = false
    const selectGroup = jest.fn()
    renderConsole({
      console: { selectedGroupId: group.id, detail: { group, incidents: [] }, selectGroup },
    })
    expect(screen.queryByTestId("console-detail-pane")).toBeNull()
    expect(screen.queryByTestId("console-detail-drawer")).toBeNull()
    await userEvent.click(screen.getByTestId("console-group-row"))
    expect(selectGroup).toHaveBeenCalledWith(group.id)
    expect(await screen.findByTestId("console-detail-drawer")).toBeInTheDocument()
  })

  it("shows a loading state for a selected group whose detail has not arrived", () => {
    renderConsole({ console: { selectedGroupId: group.id, detail: null } })
    expect(screen.getByTestId("console-detail-loading")).toBeInTheDocument()
  })

  it("saves a downloaded artifact as <supportCode>-part<N>.<kind>", async () => {
    const downloadArtifact = jest.fn(async () => new Uint8Array([1, 2, 3]))
    renderConsole({
      console: {
        selectedGroupId: group.id,
        detail: { group, incidents: [incident] },
        incidentDetail: { incident, artifacts: [minidumpPart], audit: [] },
        downloadArtifact,
      },
    })
    await userEvent.click(screen.getByTestId("console-artifact-download"))
    expect(downloadArtifact).toHaveBeenCalledWith("inc-1", 3)
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalled())
    const [blob, name] = downloadBlobMock.mock.calls[0]
    expect(name).toBe("ABC123-part3.minidump")
    expect(blob.size).toBe(3)
    expect(toastSuccess).toHaveBeenCalledWith(
      'logging.workspace.console.incident.downloaded:{"filename":"ABC123-part3.minidump"}'
    )
  })

  it("says so when the artifact could not be read", async () => {
    renderConsole({
      console: {
        selectedGroupId: group.id,
        detail: { group, incidents: [incident] },
        incidentDetail: { incident, artifacts: [minidumpPart], audit: [] },
        downloadArtifact: jest.fn(async () => null),
      },
    })
    await userEvent.click(screen.getByTestId("console-artifact-download"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("logging.workspace.console.incident.downloadFailed")
    )
    expect(downloadBlobMock).not.toHaveBeenCalled()
  })

  it("labels an audit action from a newer service under a generic label", () => {
    renderConsole({
      console: {
        selectedGroupId: group.id,
        detail: { group, incidents: [incident] },
        incidentDetail: {
          incident,
          artifacts: [],
          audit: [
            {
              id: 9,
              action: "future.thing",
              incidentId: "inc-1",
              actorId: null,
              reason: null,
              details: {},
              occurredAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        },
      },
    })
    expect(
      screen.getByText(
        /logging\.workspace\.console\.auditActions\.unknown:\{"action":"future\.thing"\}/
      )
    ).toBeInTheDocument()
  })

  it("translates an incident's processing state", () => {
    renderConsole({
      console: { selectedGroupId: group.id, detail: { group, incidents: [incident] } },
    })
    expect(screen.getByTestId("console-incident-row")).toHaveTextContent(
      "logging.workspace.console.processingStates.accepted"
    )
  })
})

describe("artifactFilename", () => {
  it("is <supportCode>-part<N>.<kind>, with path characters neutralized", () => {
    expect(artifactFilename("ABC123", 2, "events")).toBe("ABC123-part2.events")
    expect(artifactFilename("../x", 1, "mini/dump")).toBe("___x-part1.mini_dump")
  })
})
