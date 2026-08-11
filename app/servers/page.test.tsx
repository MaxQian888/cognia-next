/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockCapabilities = jest.fn().mockResolvedValue({
  topologies: ["compose", "kubernetes"],
  snapshotProviders: ["none"],
  secretProviders: ["file"],
  tlsProviders: ["existing"],
  objectStoreProtocols: ["s3-compatible"],
  requiresProviderCredentials: false,
})
const mockListServers = jest.fn().mockResolvedValue([])
const mockTokenStore = {
  load: jest.fn().mockResolvedValue(null),
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
}
let mockCenterProps: Record<string, unknown> | null = null
const mockTranslate = (key: string) => key

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "account-1" }),
}))
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: () => mockTokenStore,
}))
jest.mock("@/lib/server-ops/client", () => {
  class OpsClient {
    capabilities = mockCapabilities
    listServers = mockListServers
    getServer = jest.fn()
    listBackups = jest.fn().mockResolvedValue([])
    listLogs = jest.fn().mockResolvedValue([])
  }
  class OpsError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string
    ) {
      super(message)
    }
  }
  return {
    OpsClient,
    OpsError,
    loadCachedServerList: jest.fn().mockReturnValue([]),
    saveCachedServerList: jest.fn(),
  }
})
jest.mock("@/lib/server-ops/operation-stream", () => ({
  followOperationStream: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/components/servers/server-operations-center", () => ({
  ServerOperationsCenter: (props: Record<string, unknown>) => {
    mockCenterProps = props
    return (
      <button type="button" onClick={props.onDisconnect as () => void}>
        disconnect
      </button>
    )
  },
}))

const ServersPage = jest.requireActual<typeof import("./page")>("./page").default

beforeEach(() => {
  localStorage.clear()
  mockCenterProps = null
  mockCapabilities.mockClear()
  mockListServers.mockClear()
  mockTokenStore.load.mockClear()
  mockTokenStore.save.mockClear()
  mockTokenStore.delete.mockClear()
})

it("connects with keyring-backed credentials, exposes capabilities, and disconnects cleanly", async () => {
  render(<ServersPage />)

  fireEvent.change(screen.getByLabelText("connection.controllerUrl"), {
    target: { value: "https://ops.example.com" },
  })
  fireEvent.change(screen.getByLabelText("connection.targetId"), {
    target: { value: "production" },
  })
  fireEvent.change(screen.getByLabelText("connection.accessToken"), {
    target: { value: "oidc-token" },
  })
  fireEvent.submit(screen.getByRole("button", { name: "connection.connect" }).closest("form")!)

  await screen.findByRole("button", { name: "disconnect" })
  expect(mockTokenStore.save).toHaveBeenCalledWith(
    "account-1:production:access-token",
    "oidc-token"
  )
  await waitFor(() =>
    expect(mockCenterProps).toEqual(
      expect.objectContaining({
        controllerUrl: "https://ops.example.com",
        targetId: "production",
        capabilities: expect.objectContaining({ topologies: ["compose", "kubernetes"] }),
        eventStreamConnected: true,
      })
    )
  )

  fireEvent.click(screen.getByRole("button", { name: "disconnect" }))
  await waitFor(() =>
    expect(mockTokenStore.delete).toHaveBeenCalledWith("account-1:production:access-token")
  )
  expect(await screen.findByRole("button", { name: "connection.connect" })).toBeInTheDocument()
})
