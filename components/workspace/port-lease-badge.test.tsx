/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { PortLeaseBadge } from "./port-lease-badge"
import type { WorkspacePortLease } from "@/lib/task-workspace/types"

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values: Record<string, string | number> = {}) => {
      const messages = jest.requireActual("@/i18n/messages/en/portLease.json")
      const message = key.split(".").reduce((value, part) => value[part], messages)
      return message.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(values[name]))
    },
}))

const lease: WorkspacePortLease = {
  leaseId: "lease-1",
  namespaceKey: "host-loopback",
  subjectKind: "registry",
  subjectKey: "ws-1",
  canonicalRoot: "/repo",
  registryWorkspaceId: "ws-1",
  basePort: 41000,
  portCount: 10,
  createdAt: 1,
  updatedAt: 1,
}

it("renders range, count, host namespace, occupied ports and matching diagnostics", () => {
  render(
    <PortLeaseBadge
      lease={lease}
      occupiedPorts={[41001, 41005]}
      diagnostics={[
        { kind: "overlap", leaseIds: ["lease-1"], detail: "overlaps lease-2" },
        { kind: "missingRoot", leaseIds: ["unrelated"], detail: "absent" },
      ]}
    />
  )
  expect(screen.getByText("41000–41009 · 10 ports")).toBeInTheDocument()
  expect(screen.getByText("Host")).toBeInTheDocument()
  expect(screen.getByText("Bound ports: 41001, 41005 (report only)")).toBeInTheDocument()
  expect(screen.getByText("Overlapping port blocks")).toHaveAttribute("title", "overlaps lease-2")
  expect(screen.queryByText("Missing root / orphan lease")).not.toBeInTheDocument()
})

it("distinguishes unchecked, unavailable and probed-free occupancy", () => {
  const { rerender } = render(<PortLeaseBadge lease={lease} />)
  expect(screen.getByText("Occupancy not checked")).toBeInTheDocument()
  rerender(
    <PortLeaseBadge
      lease={{ ...lease, namespaceKey: "runtime:container-1" }}
      occupiedPorts={null}
      occupancyError="Probe unavailable"
    />
  )
  expect(screen.getByText("Runtime: runtime:container-1")).toBeInTheDocument()
  expect(screen.getByText("Occupancy unavailable")).toBeInTheDocument()
  expect(screen.getByText("Probe unavailable")).toBeInTheDocument()
  rerender(<PortLeaseBadge lease={lease} occupiedPorts={[]} />)
  expect(screen.getByText("No bound ports at last check")).toBeInTheDocument()
})

it("labels unassigned, loading, host errors and inert web states distinctly", () => {
  const { rerender } = render(<PortLeaseBadge />)
  expect(screen.getByText("Ports not assigned yet")).toBeInTheDocument()
  rerender(<PortLeaseBadge loading />)
  expect(screen.getByText("Loading port lease…")).toBeInTheDocument()
  rerender(<PortLeaseBadge error="Host disconnected" />)
  expect(screen.getByRole("alert")).toHaveTextContent("Host disconnected")
  rerender(<PortLeaseBadge inert />)
  expect(
    screen.getByText("Port leases require the desktop app or a connected host")
  ).toBeInTheDocument()
})
