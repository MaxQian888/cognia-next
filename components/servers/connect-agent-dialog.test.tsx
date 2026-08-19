/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ServerDetail } from "@/lib/server-ops/client"
import { ConnectAgentDialog } from "./connect-agent-dialog"

const server = (overrides: Partial<ServerDetail> = {}): ServerDetail => ({
  id: "staging",
  label: "Staging",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "unknown",
  releaseDigest: null,
  lastSeenAt: null,
  targetRevision: 1,
  productionCertified: false,
  certificationIssues: [],
  capabilities: {
    topologies: [],
    snapshotProviders: [],
    secretProviders: [],
    tlsProviders: [],
    objectStoreProtocols: [],
    requiresProviderCredentials: false,
  },
  ...overrides,
})

function renderDialog(props: Partial<React.ComponentProps<typeof ConnectAgentDialog>> = {}) {
  const onIssueToken = jest.fn().mockResolvedValue({
    token: "6f1c0b6e-6c1a-4a7f-9c2f-2a0e2f7b1d33",
    expiresAt: "2026-08-19T11:00:00.000Z",
  })
  const onRefresh = jest.fn().mockResolvedValue(undefined)
  const onOpenChange = jest.fn()
  const view = render(
    <ConnectAgentDialog
      open
      onOpenChange={onOpenChange}
      servers={[server()]}
      controllerUrl="https://ops.example.com"
      onIssueToken={onIssueToken}
      onRefresh={onRefresh}
      {...props}
    />
  )
  return { onIssueToken, onRefresh, onOpenChange, ...view }
}

it("issues a token for the selected target and shows the enrollment runbook", async () => {
  const user = userEvent.setup()
  const { onIssueToken } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Issue enrollment token" }))
  expect(onIssueToken).toHaveBeenCalledWith("staging")

  await screen.findByText("Enrollment token issued")
  // The token is staged through an owner-only file, never passed as `--token`.
  expect(screen.getByText(/--token-file/)).toBeInTheDocument()
  expect(screen.getByText(/6f1c0b6e-6c1a-4a7f-9c2f-2a0e2f7b1d33/)).toBeInTheDocument()
})

it("keeps waiting until the target's last-seen actually moves", async () => {
  const user = userEvent.setup()
  const { rerender, onIssueToken } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Issue enrollment token" }))
  await screen.findByText("Enrollment token issued")
  expect(screen.getByText("Waiting for the agent's first heartbeat…")).toBeInTheDocument()

  // Issuing a token proves nothing about the host. Only the controller
  // stamping `lastSeenAt` shows an agent actually dialled in.
  rerender(
    <ConnectAgentDialog
      open
      onOpenChange={jest.fn()}
      servers={[server({ lastSeenAt: "2026-08-19T10:30:00.000Z", health: "healthy" })]}
      controllerUrl="https://ops.example.com"
      onIssueToken={onIssueToken}
      onRefresh={jest.fn().mockResolvedValue(undefined)}
    />
  )

  await waitFor(() => expect(screen.getByText(/Staging is online/)).toBeInTheDocument())
})

it("does not offer a token when there is no target to bind it to", () => {
  renderDialog({ servers: [] })
  expect(screen.getByText("No targets yet")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Issue enrollment token" })).not.toBeInTheDocument()
})

it("starts fresh on each opening rather than re-showing a spent token", async () => {
  const user = userEvent.setup()
  const { rerender, onIssueToken, onRefresh } = renderDialog()

  await user.click(screen.getByRole("button", { name: "Issue enrollment token" }))
  await screen.findByText("Enrollment token issued")

  const props = {
    servers: [server()],
    controllerUrl: "https://ops.example.com",
    onIssueToken,
    onRefresh,
    onOpenChange: jest.fn(),
  }
  rerender(<ConnectAgentDialog open={false} {...props} />)
  rerender(<ConnectAgentDialog open {...props} />)

  // A single-use token from a previous opening is spent or expired; showing it
  // again would invite a retry that cannot work.
  expect(screen.queryByText("Enrollment token issued")).not.toBeInTheDocument()
})

it("preselects the target it was opened from", () => {
  renderDialog({
    servers: [server(), server({ id: "production", label: "Production" })],
    initialTargetId: "production",
  })
  expect(screen.getByRole("combobox", { name: /Target/ })).toHaveTextContent("Production")
})
