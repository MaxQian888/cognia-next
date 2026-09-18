/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
  useFormatter: () => ({ relativeTime: () => "1m ago" }),
  useNow: () => new Date(0),
}))

// Resolve the query the component hands each call — the real hook is a Dexie
// live-query; here it runs once against the mocked lib functions.
jest.mock("@/hooks/data", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    useClientLiveQuery: (query: () => Promise<unknown>, deps: unknown[], initial: unknown) => {
      const [v, setV] = React.useState(initial)
      React.useEffect(() => {
        let cancelled = false
        Promise.resolve(query()).then((r) => {
          if (!cancelled) setV(r)
        })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps)
      return v
    },
  }
})

let intents: NotificationDeliveryIntent[]
const targetLabels = new Map<string, string>()
jest.mock("@/lib/notifications/api", () => ({
  listNotificationDeliveriesForRun: jest.fn(async (runId: string) =>
    intents.filter((i) => i.logicalKey?.startsWith(`run:${runId}:`))
  ),
}))
jest.mock("@/lib/db/notification-targets", () => ({
  getNotificationTarget: jest.fn(async (id: string) =>
    targetLabels.has(id) ? { label: targetLabels.get(id) } : undefined
  ),
}))

import { RunNotificationsTab } from "./run-notifications-tab"

function intent(over: Partial<NotificationDeliveryIntent>): NotificationDeliveryIntent {
  return {
    id: "i1",
    scopeKey: "k",
    scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
    operationKey: "op",
    targetId: "t1",
    targetAddress: { kind: "feishu-webhook", endpointSecretRef: "r", region: "feishu" },
    targetVersion: 1,
    purpose: "terminal-state",
    category: "run.terminal",
    status: "accepted",
    attemptCount: 1,
    logicalKey: "run:run-1:terminal",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as NotificationDeliveryIntent
}

const row = { runId: "run-1" } as UnifiedExecutionRow

beforeEach(() => {
  intents = []
  targetLabels.clear()
})

it("shows an empty state when the run produced no external notifications", async () => {
  render(<RunNotificationsTab row={row} />)
  expect(await screen.findByTestId("run-notifications-empty")).toBeInTheDocument()
})

it("lists each delivery intent with its target label, purpose, and status", async () => {
  targetLabels.set("t1", "On-call webhook")
  intents = [
    intent({ id: "i1", status: "accepted", purpose: "terminal-state" }),
    intent({
      id: "i2",
      status: "failed",
      purpose: "approval-request",
      logicalKey: "run:run-1:approval",
    }),
  ]
  render(<RunNotificationsTab row={row} />)
  // Wait for the label map — it resolves a tick after the intents render.
  expect((await screen.findAllByText("On-call webhook")).length).toBeGreaterThan(0)
  const rows = await screen.findAllByTestId("run-notification-intent")
  expect(rows).toHaveLength(2)
  expect(screen.getByText(/agentRuns\.notifications\.status\.accepted/)).toBeInTheDocument()
  expect(screen.getByText(/agentRuns\.notifications\.status\.failed/)).toBeInTheDocument()
  expect(
    screen.getByText(/agentRuns\.notifications\.purpose\.approval-request/)
  ).toBeInTheDocument()
})

it("falls back to the target id when the target row is gone", async () => {
  intents = [intent({ id: "i1", targetId: "deleted-t" })]
  render(<RunNotificationsTab row={row} />)
  expect(await screen.findByText("deleted-t")).toBeInTheDocument()
})
