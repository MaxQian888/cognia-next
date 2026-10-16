/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { PortLeasesBlock } from "./port-leases-block"
import {
  listWorkspacePortLeases,
  releaseSubjectPortLeases,
  releaseWorkspacePortLease,
  ensureWorkspacePortLease,
  ensureSubjectPortLease,
  resolveWorkspacePortLeaseEnsure,
} from "@/lib/task-workspace/client"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import type { PortLeaseDiagnostic, WorkspacePortLeaseList } from "@/lib/task-workspace/types"

jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspacePortLeases: jest.fn(),
  releaseSubjectPortLeases: jest.fn(),
  releaseWorkspacePortLease: jest.fn(),
  ensureWorkspacePortLease: jest.fn(),
  ensureSubjectPortLease: jest.fn(),
  resolveWorkspacePortLeaseEnsure: jest.fn(),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  ...jest.requireActual("@/lib/task-workspace/user-action"),
  runWorkspaceUserAction: jest.fn((_command, operation) => operation()),
}))
let mockHasHost = true
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  hasHostRuntime: () => mockHasHost,
}))

const diagnosticKinds: PortLeaseDiagnostic["kind"][] = [
  "duplicateRoot",
  "overlap",
  "outOfRange",
  "ambiguousRegistryLink",
  "unresolvedRegistryRoot",
  "registryRootMismatch",
  "missingRoot",
  "discoveryRejected",
  "discoveryFailed",
]
function inventory(): WorkspacePortLeaseList {
  return {
    leases: [
      {
        lease: {
          leaseId: "lease-1",
          namespaceKey: "host-loopback",
          subjectKind: "registry",
          subjectKey: "workspace-1",
          canonicalRoot: "/missing/checkout",
          registryWorkspaceId: "workspace-1",
          basePort: 41000,
          portCount: 10,
          createdAt: 1,
          updatedAt: 1,
        },
        subjects: [
          { kind: "registry", key: "workspace-1" },
          { kind: "desktop-session", key: "session-1" },
          { kind: "project-root", key: "project-1" },
          { kind: "project-root", key: "root:/missing/checkout" },
        ],
        occupiedPorts: [41002, 41005],
        occupancyError: null,
      },
    ],
    diagnostics: diagnosticKinds.map((kind) => ({
      kind,
      leaseIds: kind.startsWith("discovery") ? [] : ["lease-1"],
      detail: `Host detail: ${kind}`,
    })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockHasHost = true
  jest.mocked(listWorkspacePortLeases).mockReset().mockResolvedValue(inventory())
  jest.mocked(releaseWorkspacePortLease).mockReset().mockResolvedValue(undefined)
  jest.mocked(releaseSubjectPortLeases).mockReset().mockResolvedValue(undefined)
})

it("renders all subjects, physical path, namespace, occupancy and every diagnostic without allocating", async () => {
  render(<PortLeasesBlock />)
  expect(await screen.findByText("Registry workspace: workspace-1")).toBeInTheDocument()
  expect(screen.getByText("Desktop session: session-1")).toBeInTheDocument()
  expect(screen.getByText("Project root: project-1")).toBeInTheDocument()
  expect(screen.getByText("Host-discovered checkout root: /missing/checkout")).toBeInTheDocument()
  expect(screen.getByText("Root: /missing/checkout")).toBeInTheDocument()
  expect(screen.getByText(/41000–41009/)).toBeInTheDocument()
  expect(screen.getByText("Host")).toBeInTheDocument()
  expect(screen.getByText(/41002, 41005/)).toBeInTheDocument()
  for (const kind of diagnosticKinds)
    expect(screen.getByText(new RegExp(`Host detail: ${kind}`))).toBeInTheDocument()
  expect(ensureWorkspacePortLease).not.toHaveBeenCalled()
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
})

it("confirms a registry release before invoking the approved host command, then refreshes", async () => {
  render(<PortLeasesBlock />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Release Registry workspace: workspace-1" })
  )
  const dialog = screen.getByRole("alertdialog")
  expect(within(dialog).getByText(/block may be reassigned/)).toBeInTheDocument()
  expect(releaseWorkspacePortLease).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(releaseWorkspacePortLease).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Release Registry workspace: workspace-1" }))
  fireEvent.click(screen.getByRole("button", { name: "Confirm release" }))
  await waitFor(() =>
    expect(releaseWorkspacePortLease).toHaveBeenCalledWith("workspace-1", "host-loopback")
  )
  expect(runWorkspaceUserAction).toHaveBeenCalledWith(
    "task_workspace_port_lease_release",
    expect.any(Function)
  )
  await waitFor(() => expect(listWorkspacePortLeases).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
})

it.each([
  ["Desktop session: session-1", "desktop-session", "session-1"],
  ["Project root: project-1", "project-root", "project-1"],
  ["Host-discovered checkout root: /missing/checkout", "project-root", "root:/missing/checkout"],
])("releases only the selected missing-root subject %s", async (label, kind, key) => {
  render(<PortLeasesBlock />)
  fireEvent.click(await screen.findByRole("button", { name: `Release ${label}` }))
  fireEvent.click(screen.getByRole("button", { name: "Confirm release" }))
  await waitFor(() =>
    expect(releaseSubjectPortLeases).toHaveBeenCalledWith({
      kind,
      key,
      namespace: "host-loopback",
      leaseId: "lease-1",
    })
  )
  expect(runWorkspaceUserAction).toHaveBeenCalledWith(
    "task_workspace_port_lease_subject_release",
    expect.any(Function)
  )
  await waitFor(() => expect(listWorkspacePortLeases).toHaveBeenCalledTimes(2))
})

it.each([
  "workspace workspace-1 in state Active cannot release its port lease",
  "port lease lease-1 is occupied on ports [41002, 41005]",
])("preserves refusal text and refreshes occupancy: %s", async (message) => {
  jest.mocked(releaseWorkspacePortLease).mockRejectedValue(new Error(message))
  render(<PortLeasesBlock />)
  fireEvent.click(
    await screen.findByRole("button", { name: "Release Registry workspace: workspace-1" })
  )
  fireEvent.click(screen.getByRole("button", { name: "Confirm release" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(message)
  await waitFor(() => expect(listWorkspacePortLeases).toHaveBeenCalledTimes(2))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()
})

it("does not offer subject detachment for healthy roots", async () => {
  jest.mocked(listWorkspacePortLeases).mockResolvedValue({ ...inventory(), diagnostics: [] })
  render(<PortLeasesBlock />)
  await screen.findByText("Desktop session: session-1")
  expect(
    screen.queryByRole("button", { name: "Release Desktop session: session-1" })
  ).not.toBeInTheDocument()
})

it("renders an explicit inert web state with no reads or actions", () => {
  mockHasHost = false
  render(<PortLeasesBlock />)
  expect(screen.getByRole("status")).toHaveTextContent("inactive in web mode")
  expect(listWorkspacePortLeases).not.toHaveBeenCalled()
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

it("shows loading, an empty response, and a raw read error with retry", async () => {
  jest.mocked(listWorkspacePortLeases).mockResolvedValueOnce({ leases: [], diagnostics: [] })
  render(<PortLeasesBlock />)
  expect(screen.getByText("Loading port leases…")).toBeInTheDocument()
  expect(await screen.findByText("No port leases have been assigned yet.")).toBeInTheDocument()
  jest.mocked(listWorkspacePortLeases).mockRejectedValueOnce(new Error("inventory unavailable"))
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("inventory unavailable")
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  expect(await screen.findByText("Registry workspace: workspace-1")).toBeInTheDocument()
})
