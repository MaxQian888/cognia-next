/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${ns}.${key}:${JSON.stringify(vars)}` : `${ns}.${key}`,
}))

let intents: Array<Pick<NotificationDeliveryIntent, "status">>
jest.mock("@/lib/notifications/api", () => ({
  listNotificationDeliveries: jest.fn(async () => intents),
}))

import { NotificationDeliveryBadge } from "./notification-delivery-badge"

beforeEach(() => {
  intents = []
})

it("renders nothing when there are no intents", async () => {
  const { container } = render(<NotificationDeliveryBadge logicalKey="lk" />)
  await waitFor(() => expect(screen.queryByTestId("delivery-badge")).toBeNull())
  expect(container.querySelector("[data-testid=delivery-badge]")).toBeNull()
})

it("renders nothing when every intent is superseded or cancelled", async () => {
  intents = [{ status: "superseded" }, { status: "cancelled" }]
  render(<NotificationDeliveryBadge logicalKey="lk" />)
  await waitFor(() =>
    expect(
      // give the effect a tick to resolve
      document.querySelector("[data-testid=delivery-badge]")
    ).toBeNull()
  )
})

it("shows accepted when all live intents were accepted", async () => {
  intents = [{ status: "accepted" }, { status: "accepted" }]
  render(<NotificationDeliveryBadge logicalKey="lk" />)
  const badge = await screen.findByTestId("delivery-badge")
  expect(badge).toHaveAttribute("data-status", "accepted")
})

it("shows failed when a live intent failed", async () => {
  intents = [{ status: "accepted" }, { status: "failed" }]
  render(<NotificationDeliveryBadge logicalKey="lk" />)
  const badge = await screen.findByTestId("delivery-badge")
  expect(badge).toHaveAttribute("data-status", "failed")
})

it("shows pending while an intent is in flight", async () => {
  intents = [{ status: "accepted" }, { status: "queued" }]
  render(<NotificationDeliveryBadge logicalKey="lk" />)
  const badge = await screen.findByTestId("delivery-badge")
  expect(badge).toHaveAttribute("data-status", "pending")
})

it("shows mixed when pending and failed coexist", async () => {
  intents = [{ status: "queued" }, { status: "failed" }]
  render(<NotificationDeliveryBadge logicalKey="lk" />)
  const badge = await screen.findByTestId("delivery-badge")
  expect(badge).toHaveAttribute("data-status", "mixed")
})
