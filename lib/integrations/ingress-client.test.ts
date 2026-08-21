import { detectPlatform } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { publishIntegrationEvent } from "./events"
import {
  drainIntegrationIngress,
  getIntegrationIngressDeadletter,
  installIntegrationIngressRuntime,
  listIntegrationIngressDeadletters,
  requeueIntegrationIngressDeadletter,
  syncIntegrationIngressRoutes,
} from "./ingress-client"
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
  ingressEndpoint: {
    id: "endpoint-1",
    accountId: "account-1",
    routeId: "route-1",
    secretHandle: "secret-1",
    enabled: true,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
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
const mockedSubscribe = jest.mocked(transport.subscribe)
const unsubscribe = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  mockedSubscribe.mockReturnValue(unsubscribe)
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

it("syncs one account-level generic Rust ingress route", async () => {
  await expect(syncIntegrationIngressRoutes()).resolves.toBe(1)
  expect(mockedCall).toHaveBeenCalledWith("integration_ingress_register", {
    input: expect.objectContaining({
      routeId: "route-1",
      pluginId: "demo-delivery",
      accountId: "account-1",
      verification: expect.objectContaining({ secretHandle: "secret-1" }),
    }),
  })
  expect(
    (
      mockedCall.mock.calls.find(
        ([command]) => command === "integration_ingress_register"
      )?.[1] as {
        input: { subscriptionId?: string }
      }
    ).input.subscriptionId
  ).toBeUndefined()
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

it("lists, reads, and requeues only the plugin account's deadletters", async () => {
  mockedCall.mockImplementation(async (command) => {
    if (command === "integration_ingress_deadletters") {
      return [
        {
          routeId: "route-1",
          deliveryId: "delivery-1",
          eventType: "issue.created",
          receivedAt: "2026-07-28T00:00:00.000Z",
          attempts: 5,
        },
        {
          routeId: "another-plugin-route",
          deliveryId: "delivery-2",
          receivedAt: "2026-07-28T00:00:00.000Z",
          attempts: 5,
        },
      ] as never
    }
    if (command === "integration_ingress_deadletter") {
      return {
        routeId: "route-1",
        deliveryId: "delivery-1",
        eventType: "issue.created",
        receivedAt: "2026-07-28T00:00:00.000Z",
        attempts: 5,
        headers: { "x-github-delivery": "delivery-1" },
        body: '{"issue":1}',
      } as never
    }
    if (command === "integration_ingress_requeue") return true as never
    if (command === "integration_ingress_poll") return [] as never
    return undefined as never
  })

  await expect(listIntegrationIngressDeadletters("demo-delivery", "account-1")).resolves.toEqual([
    expect.objectContaining({ routeId: "route-1", deliveryId: "delivery-1" }),
  ])
  await expect(
    getIntegrationIngressDeadletter("demo-delivery", "account-1", "route-1", "delivery-1")
  ).resolves.toMatchObject({ body: '{"issue":1}' })
  await expect(
    requeueIntegrationIngressDeadletter("demo-delivery", "account-1", "route-1", "delivery-1")
  ).resolves.toBe(true)
  await expect(
    requeueIntegrationIngressDeadletter(
      "demo-delivery",
      "account-1",
      "another-plugin-route",
      "delivery-2"
    )
  ).rejects.toThrow("does not belong")
})

it("subscribes to the delivery wake signal before the catch-up drain", async () => {
  const dispose = await installIntegrationIngressRuntime()

  expect(mockedSubscribe).toHaveBeenCalledWith(
    "integration:delivery-available",
    expect.any(Function)
  )
  // The spool has no polling timer: a delivery accepted between the drain and
  // the subscribe used to raise its wake signal into a subscription that did
  // not exist yet, and then sat until some later delivery drained it.
  const pollCall = mockedCall.mock.calls.findIndex(
    ([command]) => command === "integration_ingress_poll"
  )
  expect(pollCall).toBeGreaterThanOrEqual(0)
  expect(mockedSubscribe.mock.invocationCallOrder[0]).toBeLessThan(
    mockedCall.mock.invocationCallOrder[pollCall]
  )

  dispose()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it("keeps the wake subscription live when the catch-up pass fails", async () => {
  mockedCall.mockImplementation(async (command) => {
    if (command === "integration_ingress_poll") throw new Error("poll rejected")
    return undefined as never
  })

  const dispose = await installIntegrationIngressRuntime()

  expect(dispatchDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      code: "serverError",
      source: "connector",
      message: "poll rejected",
      meta: { extra: { stage: "startup", routeId: "runtime", deliveryId: "startup" } },
    }),
    { kind: "background" }
  )
  // Not a no-op dispose: a failed catch-up used to reject out of the installer,
  // and the caller's `.catch` swallowed it into `() => undefined`, so ingress
  // was dead for the life of the process.
  expect(dispose).toBe(unsubscribe)
  expect(mockedSubscribe).toHaveBeenCalledTimes(1)
})
