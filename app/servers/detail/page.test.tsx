/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"

import type { ServerOpsValue } from "@/components/servers/ops-context"
import type { ServerDetail } from "@/lib/server-ops/client"

jest.mock("@/components/servers/ops-context", () => ({
  useServerOps: () => mockOps,
  localizedOpsError: () => "recovery",
}))
jest.mock("@/components/servers/ops-connect-panel", () => ({
  OpsConnectPanel: () => <div>connect panel</div>,
}))
jest.mock("@/components/servers/connect-agent-dialog", () => ({
  ConnectAgentDialog: ({ open }: { open: boolean }) => (open ? <div>enroll dialog</div> : null),
}))
jest.mock("@/components/servers/server-detail", () => ({
  ServerDetailView: (props: Record<string, unknown>) => {
    detailProps = props
    return <div>detail view</div>
  },
}))
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockQuery),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

import { TooltipProvider } from "@/components/ui/tooltip"
import ServerDetailPage from "./page"

let mockQuery = "id=staging"
let mockOps: ServerOpsValue
let detailProps: Record<string, unknown> | null = null

const server = {
  id: "staging",
  label: "Staging",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
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
} as unknown as ServerDetail

const base = (): ServerOpsValue =>
  ({
    accountId: "account-1",
    connection: { controllerUrl: "https://ops.example.com", profileId: "production" },
    connected: true,
    transport: "tauri",
    liveEvents: true,
    eventStreamConnected: true,
    servers: [server],
    capabilities: null,
    operations: [],
    loading: false,
    connecting: false,
    offline: false,
    connect: jest.fn(),
    disconnect: jest.fn(),
    refresh: jest.fn(),
    serverById: (id: string) => (id === "staging" ? server : null),
    backup: jest.fn(),
    preflight: jest.fn(),
    collectStatus: jest.fn(),
    collectLogs: jest.fn(),
    restore: jest.fn(),
    rollback: jest.fn(),
    rotateKey: jest.fn(),
    upgrade: jest.fn(),
    cancelOperation: jest.fn(),
    registerAndDeploy: jest.fn(),
    createEnrollmentToken: jest.fn(),
    listBackups: jest.fn().mockResolvedValue([{ id: "rp-1" }]),
    listLogs: jest.fn().mockResolvedValue([{ id: 1 }]),
  }) as unknown as ServerOpsValue

function renderPage() {
  return render(
    <TooltipProvider>
      <ServerDetailPage />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mockQuery = "id=staging"
  mockOps = base()
  detailProps = null
})

it("reads the target from the query string, not a dynamic segment", async () => {
  // Dynamic routes are unservable under `output: "export"` — every target id
  // is created at runtime.
  renderPage()
  await waitFor(() => expect(screen.getByText("detail view")).toBeInTheDocument())
  expect(mockOps.listBackups).toHaveBeenCalledWith("staging")
  expect(mockOps.listLogs).toHaveBeenCalledWith("staging")
})

it("loads the recovery points and logs for that target", async () => {
  renderPage()
  await waitFor(() => expect(detailProps?.backups).toEqual([{ id: "rp-1" }]))
  expect(detailProps?.logs).toEqual([{ id: 1 }])
})

it("shows nothing but summaries while running on the offline cache", async () => {
  // The cache stores summaries only, so a recovery point rendered here would be
  // an invitation to restore from something the app cannot vouch for.
  mockOps = { ...base(), offline: true }
  renderPage()

  await waitFor(() => expect(screen.getByText("detail view")).toBeInTheDocument())
  expect(mockOps.listBackups).not.toHaveBeenCalled()
  expect(detailProps?.backups).toEqual([])
})

it("explains a target that is not in this controller's fleet", async () => {
  mockQuery = "id=missing"
  renderPage()
  await waitFor(() => expect(screen.getByText("Target not found")).toBeInTheDocument())
  expect(screen.getAllByRole("link", { name: "All servers" }).length).toBeGreaterThan(0)
})

it("says it is still loading rather than claiming the target is gone", async () => {
  mockQuery = "id=missing"
  mockOps = { ...base(), loading: true }
  renderPage()
  await waitFor(() => expect(screen.getByText("Loading the fleet…")).toBeInTheDocument())
})

it("falls back to the connect screen when the controller session is gone", async () => {
  mockOps = { ...base(), connected: false }
  renderPage()
  await waitFor(() => expect(screen.getByText("connect panel")).toBeInTheDocument())
})
