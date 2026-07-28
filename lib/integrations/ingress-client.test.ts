import { detectPlatform } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { publishIntegrationEvent } from "./events"
import { drainIntegrationIngress, syncIntegrationIngressRoutes } from "./ingress-client"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

const subscription = {
  id: "subscription-1",
  pluginId: "demo-delivery",
  integrationId: "demo",
  accountId: "account-1",
  eventTypes: ["issue.created"],
  ingressRouteId: "route-1",
  ingressSecretHandle: "secret-1",
  enabled: true,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
}
const account = {
  id: "account-1",
  pluginId: "demo-delivery",
  integrationId: "demo",
  providerId: "demo",
  authSessionId: "auth-1",
  remoteAccountId: "remote-1",
  label: "Demo",
  enabled: true,
  health: "healthy",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
}
const mockNormalizer = jest.fn(async () => ({
  schemaVersion: 1 as const,
  id: "event-1",
  pluginId: "demo-delivery",
  integrationId: "demo",
  accountId: "account-1",
  deliveryId: "delivery-1",
  eventType: "issue.created",
  occurredAt: "2026-07-28T00:00:00.000Z",
  receivedAt: "2026-07-28T00:00:00.000Z",
  payload: { id: "issue-1" },
}))

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn(() => jest.fn()) },
}))
jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn(() => "tauri") }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    integrationSubscriptions: {
      toArray: jest.fn(async () => [subscription]),
      get: jest.fn(async () => subscription),
    },
    integrationAccounts: { toArray: jest.fn(async () => [account]) },
  }),
}))
jest.mock("./registry", () => ({
  getRegisteredIntegration: () => ({
    definition: {
      ingress: {
        normalizer: "normalize",
        verification: {
          type: "hmac-sha256",
          signatureHeader: "x-signature",
          encoding: "hex",
        },
        deliveryIdHeader: "x-delivery-id",
      },
    },
  }),
  getIntegrationEventNormalizer: () => mockNormalizer,
}))
jest.mock("./events", () => ({
  publishIntegrationEvent: jest.fn(async () => ({ inserted: true })),
}))
jest.mock("@/lib/db/integrations", () => ({
  removeIntegrationAccount: jest.fn(),
  removeIntegrationSubscription: jest.fn(),
}))
jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: () => ({ delete: jest.fn() }),
}))
jest.mock("@/lib/diagnostics/bus", () => ({
  dispatchDiagnostic: jest.fn(),
}))

const mockedCall = jest.mocked(transport.call)

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(detectPlatform).mockReturnValue("tauri")
  mockedCall.mockImplementation(async (command) => {
    if (command === "integration_ingress_poll") {
      return [
        {
          routeId: "route-1",
          deliveryId: "delivery-1",
          eventType: "issue.created",
          headers: {},
          body: '{"id":"issue-1"}',
          receivedAt: "2026-07-28T00:00:00.000Z",
          attempts: 0,
        },
      ] as never
    }
    return undefined as never
  })
})

it("syncs enabled subscriptions as generic Rust ingress routes", async () => {
  await expect(syncIntegrationIngressRoutes()).resolves.toBe(1)
  expect(mockedCall).toHaveBeenCalledWith("integration_ingress_register", {
    input: expect.objectContaining({
      routeId: "route-1",
      pluginId: "demo-delivery",
      verification: expect.objectContaining({ secretHandle: "secret-1" }),
    }),
  })
})

it("normalizes, persists, and only then acknowledges spooled deliveries", async () => {
  await expect(drainIntegrationIngress()).resolves.toBe(1)
  expect(mockNormalizer).toHaveBeenCalled()
  expect(publishIntegrationEvent).toHaveBeenCalledWith(
    "demo-delivery",
    expect.objectContaining({ id: "event-1" })
  )
  expect(mockedCall).toHaveBeenCalledWith("integration_ingress_ack", {
    routeId: "route-1",
    deliveryId: "delivery-1",
  })
})

it("records the failing delivery stage before returning it to the ingress spool", async () => {
  jest.mocked(publishIntegrationEvent).mockRejectedValueOnce(new Error("publish failed"))

  await expect(drainIntegrationIngress()).resolves.toBe(0)

  expect(dispatchDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      code: "serverError",
      source: "connector",
      message: "publish failed",
      meta: {
        extra: {
          stage: "publish",
          routeId: "route-1",
          deliveryId: "delivery-1",
        },
      },
    }),
    { kind: "background" }
  )
  expect(mockedCall).toHaveBeenCalledWith("integration_ingress_nack", {
    routeId: "route-1",
    deliveryId: "delivery-1",
  })
})

it("uses the same command plane in a headless brain", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  await expect(syncIntegrationIngressRoutes()).resolves.toBe(1)
  expect(mockedCall).toHaveBeenCalledWith(
    "integration_ingress_register",
    expect.objectContaining({ input: expect.objectContaining({ routeId: "route-1" }) })
  )
})
