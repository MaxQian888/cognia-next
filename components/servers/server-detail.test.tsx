/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { RecoveryPoint, ServerDetail, ServerLogEntry } from "@/lib/server-ops/client"
import { ServerDetailView, type ServerDetailActions } from "./server-detail"

const server = (overrides: Partial<ServerDetail> = {}): ServerDetail => ({
  id: "staging",
  label: "Staging",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  lastSeenAt: "2026-08-19T10:00:00.000Z",
  targetRevision: 3,
  productionCertified: true,
  certificationIssues: [],
  capabilities: {
    topologies: ["kubernetes"],
    snapshotProviders: ["kubernetes-csi"],
    secretProviders: ["kubernetes"],
    tlsProviders: ["ingress"],
    objectStoreProtocols: ["s3-compatible"],
    requiresProviderCredentials: false,
  },
  ...overrides,
})

const recoveryPoint = (overrides: Partial<RecoveryPoint> = {}): RecoveryPoint => ({
  id: "rp-1",
  serverId: "staging",
  createdAt: "2026-08-19T09:00:00.000Z",
  kind: "snapshot",
  manifestSha256: "a".repeat(64),
  sizeBytes: 1024 * 1024 * 12,
  verified: true,
  ...overrides,
})

const logEntry = (overrides: Partial<ServerLogEntry> = {}): ServerLogEntry => ({
  id: 1,
  serverId: "staging",
  timestamp: "2026-08-19T09:30:00.000Z",
  level: "error",
  component: "cognia-server",
  message: "connection refused",
  ...overrides,
})

function renderDetail(props: Partial<React.ComponentProps<typeof ServerDetailView>> = {}) {
  const actions: ServerDetailActions = {
    onBackup: jest.fn(),
    onPreflight: jest.fn(),
    onCollectStatus: jest.fn(),
    onCollectLogs: jest.fn(),
    onRestore: jest.fn(),
    onRollback: jest.fn(),
    onRotateKey: jest.fn(),
    onUpgrade: jest.fn(),
    onConnectAgent: jest.fn(),
    ...(props.actions ?? {}),
  }
  const view = render(
    <ServerDetailView
      server={server()}
      backups={[]}
      logs={[]}
      loadingDetail={false}
      {...props}
      actions={actions}
    />
  )
  return { actions, ...view }
}

it("queues the read-only operations that previously had no entry point", async () => {
  const user = userEvent.setup()
  const { actions } = renderDetail()

  await user.click(screen.getByRole("button", { name: "Run preflight" }))
  expect(actions.onPreflight).toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "Collect status" }))
  // Runtime usage costs a slower probe, so it is opt-in and defaults off.
  expect(actions.onCollectStatus).toHaveBeenCalledWith(false)

  await user.click(screen.getByRole("switch", { name: "Include runtime resource usage" }))
  await user.click(screen.getByRole("button", { name: "Collect status" }))
  expect(actions.onCollectStatus).toHaveBeenLastCalledWith(true)
})

it("confirms a restore and names the server in the warning", async () => {
  const user = userEvent.setup()
  const { actions } = renderDetail({ backups: [recoveryPoint()] })

  await user.click(screen.getAllByRole("button", { name: "Restore" })[0])
  expect(screen.getByText(/Restoring overwrites the live data on Staging/)).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Request admin lease and continue" }))
  expect(actions.onRestore).toHaveBeenCalledWith("rp-1")
})

it("refuses to offer a rollback on a target that has never been deployed", async () => {
  const user = userEvent.setup()
  renderDetail({ server: server({ releaseDigest: null }) })

  await user.click(screen.getByRole("tab", { name: "Deployments" }))
  expect(screen.getByRole("button", { name: "Rollback" })).toBeDisabled()
  expect(
    screen.getByText(
      "No release has been deployed to this target yet, so there is nothing to roll back to."
    )
  ).toBeInTheDocument()
})

it("requires all three image digests before an upgrade can be queued", async () => {
  const user = userEvent.setup()
  const { actions } = renderDetail()

  await user.click(screen.getByRole("tab", { name: "Deployments" }))
  await user.click(screen.getByRole("button", { name: "Upgrade release" }))

  const submit = screen.getByRole("button", { name: "Queue upgrade" })
  expect(submit).toBeDisabled()

  await user.type(screen.getByLabelText("Server image"), "server@sha256:aa")
  await user.type(screen.getByLabelText("Runner image"), "runner@sha256:bb")
  expect(submit).toBeDisabled()

  await user.type(screen.getByLabelText("Workspace runtime image"), "runtime@sha256:cc")
  await user.click(submit)
  expect(actions.onUpgrade).toHaveBeenCalledWith({
    serverImage: "server@sha256:aa",
    runnerImage: "runner@sha256:bb",
    workspaceRuntimeImage: "runtime@sha256:cc",
  })
})

it("gates key rotation on a key version being supplied", async () => {
  const user = userEvent.setup()
  const { actions } = renderDetail()

  await user.click(screen.getByRole("tab", { name: "Security" }))
  const rotate = screen.getByRole("button", { name: "Rotate key" })
  expect(rotate).toBeDisabled()

  await user.type(screen.getByLabelText("Pre-provisioned key version"), "key-2026-08")
  await user.click(rotate)
  await user.click(screen.getByRole("button", { name: "Request admin lease and continue" }))
  expect(actions.onRotateKey).toHaveBeenCalledWith("key-2026-08")
})

it("surfaces certification issues on the overview instead of burying them", () => {
  renderDetail({
    server: server({
      productionCertified: false,
      certificationIssues: ["images.server must use an immutable sha256 digest"],
    }),
  })
  expect(screen.getByText("images.server must use an immutable sha256 digest")).toBeInTheDocument()
})

it("renders log lines as log lines, with the level called out", async () => {
  const user = userEvent.setup()
  renderDetail({ logs: [logEntry()] })

  await user.click(screen.getByRole("tab", { name: "Logs" }))
  expect(screen.getByText("connection refused")).toBeInTheDocument()
  expect(screen.getByText("error")).toBeInTheDocument()
  expect(screen.getByText("cognia-server")).toBeInTheDocument()
})

it("offers a way to fetch logs from the empty state", async () => {
  const user = userEvent.setup()
  const { actions } = renderDetail()

  await user.click(screen.getByRole("tab", { name: "Logs" }))
  expect(screen.getByText("No logs collected yet")).toBeInTheDocument()
  await user.click(screen.getAllByRole("button", { name: "Collect logs" })[0])
  expect(actions.onCollectLogs).toHaveBeenCalled()
})

it("shows a recovery point's size and kind so a restore is an informed choice", async () => {
  const user = userEvent.setup()
  renderDetail({ backups: [recoveryPoint()] })

  await user.click(screen.getByRole("tab", { name: "Backups" }))
  expect(screen.getByText(/12\.0 MiB/)).toBeInTheDocument()
  expect(screen.getByText(/Volume snapshot/)).toBeInTheDocument()
  expect(screen.getByText("Verified")).toBeInTheDocument()
})
