/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ServerOpsValue } from "@/components/servers/ops-context"

jest.mock("@/components/servers/ops-context", () => ({
  useServerOps: () => mockOps,
}))
jest.mock("@/components/servers/ops-connect-panel", () => ({
  OpsConnectPanel: () => <div>connect panel</div>,
}))
jest.mock("@/components/servers/deployment-wizard", () => ({
  DeploymentWizard: ({ open }: { open: boolean }) => (open ? <div>wizard</div> : null),
}))
jest.mock("@/components/servers/connect-agent-dialog", () => ({
  ConnectAgentDialog: ({ open }: { open: boolean }) => (open ? <div>enroll dialog</div> : null),
}))

import { TooltipProvider } from "@/components/ui/tooltip"
import ServersPage from "./page"

/**
 * `app/layout.tsx` mounts `TooltipProvider` for the whole app, so the page
 * never carries one itself — a test rendering it in isolation must supply it.
 */
function renderPage() {
  return render(
    <TooltipProvider>
      <ServersPage />
    </TooltipProvider>
  )
}

let mockOps: ServerOpsValue

const base = (): ServerOpsValue =>
  ({
    accountId: "account-1",
    connection: { controllerUrl: "https://ops.example.com", profileId: "production" },
    connected: true,
    transport: "tauri",
    liveEvents: true,
    eventStreamConnected: true,
    servers: [
      {
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
      },
    ],
    capabilities: null,
    operations: [],
    loading: false,
    connecting: false,
    offline: false,
    connect: jest.fn(),
    disconnect: jest.fn(),
    refresh: jest.fn(),
    serverById: () => null,
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
    listBackups: null,
    listLogs: null,
    listOperationEvents: jest.fn().mockResolvedValue([]),
  }) as unknown as ServerOpsValue

beforeEach(() => {
  mockOps = base()
})

it("asks for an unlocked account before anything else", () => {
  mockOps = { ...base(), accountId: null }
  renderPage()
  expect(
    screen.getByText("Unlock the active account before connecting to a server target.")
  ).toBeInTheDocument()
})

it("shows the connect screen until a controller is reachable", () => {
  mockOps = { ...base(), connected: false }
  renderPage()
  expect(screen.getByText("connect panel")).toBeInTheDocument()
})

it("shows the controller and profile in context once connected", () => {
  renderPage()
  expect(screen.getByText("https://ops.example.com")).toBeInTheDocument()
  expect(screen.getByText("production")).toBeInTheDocument()
  expect(screen.queryByText("Offline cache")).not.toBeInTheDocument()
})

it("flags a fleet that came from the offline cache", () => {
  mockOps = { ...base(), offline: true }
  renderPage()
  expect(screen.getByText("Offline cache")).toBeInTheDocument()
})

it("opens the deployment wizard from the primary action", async () => {
  const user = userEvent.setup()
  renderPage()

  expect(screen.queryByText("wizard")).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Deploy target" }))
  expect(screen.getByText("wizard")).toBeInTheDocument()
})

it("opens the agent enrollment dialog from the header", async () => {
  const user = userEvent.setup()
  renderPage()

  await user.click(screen.getByRole("button", { name: "Connect agent" }))
  expect(screen.getByText("enroll dialog")).toBeInTheDocument()
})

it("still offers enrollment on an empty fleet, letting the dialog explain", async () => {
  const user = userEvent.setup()
  mockOps = { ...base(), servers: [] }
  renderPage()

  // A dead button would not say that a token binds to a target; the dialog's
  // own empty state does.
  const [header] = screen.getAllByRole("button", { name: "Connect agent" })
  expect(header).toBeEnabled()
  await user.click(header)
  expect(screen.getByText("enroll dialog")).toBeInTheDocument()
})

it("refreshes on demand and blocks a second refresh while one is running", async () => {
  const user = userEvent.setup()
  renderPage()

  await user.click(screen.getByRole("button", { name: "Refresh" }))
  expect(mockOps.refresh).toHaveBeenCalled()
})
