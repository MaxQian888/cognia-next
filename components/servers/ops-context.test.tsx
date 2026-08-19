/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Operation, ServerDetail, ServerSummary } from "@/lib/server-ops/client"

// Every mock below is created INSIDE its factory: `jest.mock` is hoisted above
// the `const` declarations, so referencing an outer binding from a factory hits
// the temporal dead zone.
jest.mock("@/lib/server-ops/client", () => ({
  ...jest.requireActual("@/lib/server-ops/client"),
  OpsClient: jest.fn(),
  loadCachedServerList: jest.fn(() => []),
  saveCachedServerList: jest.fn(),
}))
jest.mock("@/lib/server-ops/transport", () => ({
  createOpsFetch: jest.fn(),
  createOpsEventStream: jest.fn(),
  opsTransportKind: jest.fn(),
  supportsLiveOperationEvents: jest.fn(),
}))
jest.mock("@/lib/credentials/keyring-store", () => {
  const store = { load: jest.fn(), save: jest.fn(), delete: jest.fn() }
  return { createKeyringStore: () => store }
})
jest.mock("@/lib/server-ops/operation-stream", () => ({
  ...jest.requireActual("@/lib/server-ops/operation-stream"),
  followOperationStream: jest.fn(),
  pollOperationUpdates: jest.fn(),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId: "account-1" }),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { OpsClient } from "@/lib/server-ops/client"
import { followOperationStream, pollOperationUpdates } from "@/lib/server-ops/operation-stream"
import {
  createOpsEventStream,
  createOpsFetch,
  opsTransportKind,
  supportsLiveOperationEvents,
} from "@/lib/server-ops/transport"

const OpsClientMock = OpsClient as unknown as jest.Mock
const tokenStore = createKeyringStore("server-ops-oidc") as unknown as {
  load: jest.Mock
  save: jest.Mock
  delete: jest.Mock
}
const followOperationStreamMock = followOperationStream as jest.Mock
const pollOperationUpdatesMock = pollOperationUpdates as jest.Mock

/** Sentinels: the provider must hand these to the client, not build its own. */
const opsFetch = jest.fn()
const eventStream = jest.fn()

const client = {
  capabilities: jest.fn(),
  listServers: jest.fn(),
  getServer: jest.fn(),
  createBackup: jest.fn(),
  preflight: jest.fn(),
  collectStatus: jest.fn(),
  collectLogs: jest.fn(),
  createAdminLease: jest.fn(),
  restore: jest.fn(),
  rollback: jest.fn(),
  rotateKey: jest.fn(),
  upgrade: jest.fn(),
  cancelOperation: jest.fn(),
  createEnrollmentToken: jest.fn(),
  validateTarget: jest.fn(),
  registerTarget: jest.fn(),
  deploy: jest.fn(),
  listBackups: jest.fn(),
  listLogs: jest.fn(),
}

import { loadCachedServerList, saveCachedServerList } from "@/lib/server-ops/client"
import { ServerOpsProvider, useServerOps } from "./ops-context"

const summary: ServerSummary = {
  id: "staging",
  label: "Staging",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
  releaseDigest: null,
  lastSeenAt: null,
}
const detail: ServerDetail = {
  ...summary,
  targetRevision: 3,
  productionCertified: true,
  certificationIssues: [],
  capabilities: {
    topologies: [],
    snapshotProviders: [],
    secretProviders: [],
    tlsProviders: [],
    objectStoreProtocols: [],
    requiresProviderCredentials: false,
  },
}
const operation: Operation = {
  id: "op-1",
  targetId: "staging",
  kind: "backup",
  state: "queued",
  request: {},
  result: null,
  error: null,
  createdBy: "operator",
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
}

/** Renders the pieces of the context under test as plain, queryable DOM. */
function Probe() {
  const ops = useServerOps()
  return (
    <div>
      <span data-testid="connected">{String(ops.connected)}</span>
      <span data-testid="offline">{String(ops.offline)}</span>
      <span data-testid="servers">{ops.servers.map((server) => server.id).join(",")}</span>
      <span data-testid="operations">{ops.operations.map((item) => item.id).join(",")}</span>
      <span data-testid="revision">{ops.servers[0]?.targetRevision ?? ""}</span>
      <button onClick={() => void ops.backup("staging")}>backup</button>
      <button onClick={() => void ops.preflight("staging")}>preflight</button>
      <button onClick={() => void ops.collectStatus("staging", true)}>collect</button>
      <button onClick={() => void ops.rollback("staging")}>rollback</button>
      <button
        onClick={() =>
          void ops.upgrade("staging", {
            serverImage: "s",
            runnerImage: "r",
            workspaceRuntimeImage: "w",
          })
        }
      >
        upgrade
      </button>
      <button onClick={() => void ops.disconnect()}>disconnect</button>
    </div>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  OpsClientMock.mockImplementation(() => client)
  ;(createOpsFetch as jest.Mock).mockReturnValue(opsFetch)
  ;(createOpsEventStream as jest.Mock).mockReturnValue(eventStream)
  ;(opsTransportKind as jest.Mock).mockReturnValue("tauri")
  ;(supportsLiveOperationEvents as jest.Mock).mockReturnValue(true)
  tokenStore.load.mockResolvedValue("token")
  tokenStore.save.mockResolvedValue(undefined)
  tokenStore.delete.mockResolvedValue(undefined)
  client.capabilities.mockResolvedValue({
    topologies: ["kubernetes"],
    snapshotProviders: [],
    secretProviders: [],
    tlsProviders: [],
    objectStoreProtocols: [],
    requiresProviderCredentials: false,
  })
  client.listServers.mockResolvedValue([summary])
  client.getServer.mockResolvedValue(detail)
  client.createBackup.mockResolvedValue(operation)
  client.preflight.mockResolvedValue({ ...operation, id: "op-preflight", kind: "preflight" })
  client.collectStatus.mockResolvedValue({ ...operation, id: "op-status" })
  client.createAdminLease.mockResolvedValue({ token: "lease", expiresAt: "" })
  client.rollback.mockResolvedValue({ ...operation, id: "op-rollback" })
  client.upgrade.mockResolvedValue({ ...operation, id: "op-upgrade" })
  followOperationStreamMock.mockResolvedValue(undefined)
  pollOperationUpdatesMock.mockResolvedValue(undefined)
})

/** Seed a stored connection so the provider hydrates into a connected state. */
function seedConnection() {
  localStorage.setItem(
    "cognia.server-ops.connection.v1.account-1",
    JSON.stringify({ controllerUrl: "https://ops.example.com", profileId: "production" })
  )
}

async function renderConnected() {
  seedConnection()
  render(
    <ServerOpsProvider>
      <Probe />
    </ServerOpsProvider>
  )
  await waitFor(() => expect(screen.getByTestId("connected")).toHaveTextContent("true"))
}

it("builds the client on the platform transport rather than a renderer fetch", async () => {
  await renderConnected()

  // The whole reason the workspace was dead: the desktop WebView's CSP blocks a
  // renderer `fetch` to a user-supplied controller host.
  expect(OpsClientMock.mock.calls[0][0]).toMatchObject({
    baseUrl: "https://ops.example.com",
    fetchImpl: opsFetch,
    eventStream,
  })
})

it("does not report a connection whose keyring entry has been purged", async () => {
  tokenStore.load.mockResolvedValue(null)
  seedConnection()
  render(
    <ServerOpsProvider>
      <Probe />
    </ServerOpsProvider>
  )

  // A stored URL without its token would render a connected shell that fails
  // on its first request.
  await waitFor(() => expect(tokenStore.load).toHaveBeenCalled())
  expect(screen.getByTestId("connected")).toHaveTextContent("false")
})

it("drops a malformed stored connection instead of hydrating from it", async () => {
  localStorage.setItem("cognia.server-ops.connection.v1.account-1", "{not json")
  render(
    <ServerOpsProvider>
      <Probe />
    </ServerOpsProvider>
  )
  await waitFor(() =>
    expect(localStorage.getItem("cognia.server-ops.connection.v1.account-1")).toBeNull()
  )
})

it("loads every server's detail and caches the summaries for offline use", async () => {
  await renderConnected()
  await waitFor(() => expect(screen.getByTestId("servers")).toHaveTextContent("staging"))
  expect(saveCachedServerList).toHaveBeenCalledWith(localStorage, "account-1", "production", [
    summary,
  ])
})

it("falls back to the offline cache and says so when the controller is unreachable", async () => {
  client.listServers.mockRejectedValue(new Error("offline"))
  ;(loadCachedServerList as jest.Mock).mockReturnValue([summary])

  await renderConnected()
  await waitFor(() => expect(screen.getByTestId("offline")).toHaveTextContent("true"))
  expect(screen.getByTestId("servers")).toHaveTextContent("staging")
  // The cache holds summaries only, so nothing it cannot know is invented.
  expect(screen.getByTestId("revision")).toHaveTextContent("0")
})

it("follows the live stream where the shell can hold one open", async () => {
  await renderConnected()
  await waitFor(() => expect(followOperationStreamMock).toHaveBeenCalled())
  expect(pollOperationUpdatesMock).not.toHaveBeenCalled()
})

it("polls instead of pretending to be live on a buffered transport", async () => {
  ;(supportsLiveOperationEvents as jest.Mock).mockReturnValue(false)
  ;(createOpsEventStream as jest.Mock).mockReturnValue(null)
  ;(opsTransportKind as jest.Mock).mockReturnValue("browser")
  await renderConnected()
  await waitFor(() => expect(pollOperationUpdatesMock).toHaveBeenCalled())
  expect(followOperationStreamMock).not.toHaveBeenCalled()
})

it("records each queued operation, newest first", async () => {
  const user = userEvent.setup()
  await renderConnected()

  await user.click(screen.getByRole("button", { name: "backup" }))
  await waitFor(() => expect(screen.getByTestId("operations")).toHaveTextContent("op-1"))
  await user.click(screen.getByRole("button", { name: "preflight" }))
  await waitFor(() =>
    expect(screen.getByTestId("operations")).toHaveTextContent("op-preflight,op-1")
  )
})

it("passes the runtime-usage choice through to collect-status", async () => {
  const user = userEvent.setup()
  await renderConnected()

  await user.click(screen.getByRole("button", { name: "collect" }))
  await waitFor(() =>
    expect(client.collectStatus).toHaveBeenCalledWith("staging", expect.any(String), {
      includeRuntimeUsage: true,
    })
  )
})

it("takes a fresh admin lease for each protected operation", async () => {
  const user = userEvent.setup()
  await renderConnected()

  await user.click(screen.getByRole("button", { name: "rollback" }))
  await waitFor(() =>
    expect(client.createAdminLease).toHaveBeenCalledWith("staging", "rollback", expect.any(String))
  )
  // The lease is spent by the mutation, so it is requested at the moment of
  // use rather than held.
  expect(client.rollback).toHaveBeenCalledWith("staging", "lease", expect.any(String))
})

it("upgrades at the revision the controller reported, not one the form guessed", async () => {
  const user = userEvent.setup()
  await renderConnected()
  await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("3"))

  await user.click(screen.getByRole("button", { name: "upgrade" }))
  await waitFor(() =>
    expect(client.upgrade).toHaveBeenCalledWith(
      "staging",
      {
        targetRevision: 3,
        release: {
          serverImage: "s",
          runnerImage: "r",
          workspaceRuntimeImage: "w",
          configRevision: "3",
        },
      },
      expect.any(String)
    )
  )
})

it("clears the keyring entry and every cached view on disconnect", async () => {
  const user = userEvent.setup()
  await renderConnected()
  await waitFor(() => expect(screen.getByTestId("servers")).toHaveTextContent("staging"))

  await user.click(screen.getByRole("button", { name: "disconnect" }))

  // `disconnect` awaits the keyring delete before clearing state, so the
  // teardown lands a tick after the click resolves.
  await waitFor(() => expect(screen.getByTestId("connected")).toHaveTextContent("false"))
  expect(tokenStore.delete).toHaveBeenCalledWith("account-1:production:access-token")
  expect(localStorage.getItem("cognia.server-ops.connection.v1.account-1")).toBeNull()
  expect(screen.getByTestId("servers")).toHaveTextContent("")
})
