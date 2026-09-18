/** @jest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { NotificationTarget } from "@/types/notifications/target"
import type { NotificationSubscription } from "@/types/notifications/subscription"
import type { NotificationScope } from "@/types/notifications/scope"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}:${JSON.stringify(vars)}` : `${ns}.${key}`,
}))

const scope: NotificationScope = {
  namespaceId: "ns",
  accountId: "acct",
  authorityHostId: "host",
}
const scopeKey = "ns:acct:::"

jest.mock("@/lib/notifications/scope", () => ({
  resolveNotificationScope: jest.fn(async () => scope),
}))
jest.mock("@/types/notifications/scope", () => ({
  notificationScopeKey: () => scopeKey,
}))

let targets: NotificationTarget[]
let subscriptions: NotificationSubscription[]
const upsertTarget = jest.fn(async (_input: unknown) => ({}))
const deleteTarget = jest.fn(async (_id: string) => undefined)
const upsertSubscription = jest.fn(async (_input: unknown) => ({}))
const deleteSubscription = jest.fn(async (_id: string) => undefined)

jest.mock("@/lib/notifications/api", () => ({
  listNotificationTargets: jest.fn(async () => targets),
  upsertNotificationTarget: (input: unknown) => upsertTarget(input),
  deleteNotificationTarget: (id: string) => deleteTarget(id),
  listNotificationSubscriptions: jest.fn(async () => subscriptions),
  upsertNotificationSubscription: (input: unknown) => upsertSubscription(input),
  deleteNotificationSubscription: (id: string) => deleteSubscription(id),
}))

import { NotificationDeliveryPanel } from "./notification-delivery-panel"

function webhookTarget(over: Partial<NotificationTarget> = {}): NotificationTarget {
  return {
    id: "t1",
    version: 1,
    scope,
    scopeKey,
    label: "On-call webhook",
    address: { kind: "feishu-webhook", endpointSecretRef: "feishu:x", region: "feishu" },
    addressFingerprint: "fp",
    enabled: true,
    enabledKey: 1,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "acct", grantedAt: 1 },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function sub(over: Partial<NotificationSubscription> = {}): NotificationSubscription {
  return {
    id: "s1",
    version: 1,
    scope,
    scopeKey,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds: ["t1"],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    enabledKey: 1,
    rules: [],
    createdBy: "acct",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as NotificationSubscription
}

beforeEach(() => {
  jest.clearAllMocks()
  targets = []
  subscriptions = []
})

it("lists existing targets and subscriptions for the scope", async () => {
  targets = [webhookTarget()]
  subscriptions = [sub()]
  render(<NotificationDeliveryPanel />)
  expect(await screen.findByText("On-call webhook")).toBeInTheDocument()
  expect(screen.getByTestId("subscription-row")).toBeInTheDocument()
})

it("shows empty states when no targets or subscriptions exist", async () => {
  render(<NotificationDeliveryPanel />)
  expect(await screen.findByTestId("no-targets")).toBeInTheDocument()
  expect(screen.getByTestId("no-subscriptions")).toBeInTheDocument()
  // Subscriptions need at least one target to bind to.
  expect(screen.getByTestId("add-subscription-toggle")).toBeDisabled()
})

it("creates a webhook target with the credential ref (never the URL)", async () => {
  render(<NotificationDeliveryPanel />)
  await screen.findByTestId("no-targets")
  await userEvent.click(screen.getByTestId("add-target-toggle"))
  await userEvent.type(screen.getByLabelText(/targetNameLabel/), "Alerts")
  await userEvent.type(screen.getByLabelText(/endpointSecretRefLabel/), "feishu:hook")
  await userEvent.click(screen.getByTestId("save-target"))
  await waitFor(() => expect(upsertTarget).toHaveBeenCalled())
  const input = upsertTarget.mock.calls[0][0] as {
    address: { kind: string; endpointSecretRef: string }
  }
  expect(input.address.kind).toBe("feishu-webhook")
  expect(input.address.endpointSecretRef).toBe("feishu:hook")
})

it("toggling a target re-upserts it with CAS version", async () => {
  targets = [webhookTarget()]
  render(<NotificationDeliveryPanel />)
  const row = (await screen.findByText("On-call webhook")).closest("[data-testid=target-row]")!
  await userEvent.click(within(row as HTMLElement).getByRole("switch"))
  await waitFor(() => expect(upsertTarget).toHaveBeenCalled())
  expect((upsertTarget.mock.calls[0][0] as { enabled: boolean }).enabled).toBe(false)
  expect((upsertTarget.mock.calls[0][0] as { expectedVersion: number }).expectedVersion).toBe(1)
})

it("deletes a target via the row action", async () => {
  targets = [webhookTarget()]
  render(<NotificationDeliveryPanel />)
  const row = (await screen.findByText("On-call webhook")).closest("[data-testid=target-row]")!
  await userEvent.click(within(row as HTMLElement).getByRole("button", { name: /deleteTarget/ }))
  await waitFor(() => expect(deleteTarget).toHaveBeenCalledWith("t1"))
})

it("creates a scope subscription bound to chosen targets", async () => {
  targets = [webhookTarget()]
  render(<NotificationDeliveryPanel />)
  await screen.findByText("On-call webhook")
  await userEvent.click(screen.getByTestId("add-subscription-toggle"))
  await userEvent.click(screen.getByRole("checkbox", { name: /On-call webhook/ }))
  await userEvent.click(screen.getByTestId("save-subscription"))
  await waitFor(() => expect(upsertSubscription).toHaveBeenCalled())
  const input = upsertSubscription.mock.calls[0][0] as {
    binding: { kind: string }
    targetIds: string[]
  }
  expect(input.binding.kind).toBe("scope")
  expect(input.targetIds).toEqual(["t1"])
})
