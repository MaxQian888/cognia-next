/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { CollabRefreshStaleBadge } from "./collab-refresh-stale-badge"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct-1" }))

let stale = false
const state = { lastSuccessAt: 1, lastAttemptAt: 1, failures: 0, inFlight: false }
jest.mock("@/lib/collab/refresh-scheduler", () => ({
  subscribeCollabRefreshState: () => () => undefined,
  getCollabRefreshState: () => state,
  isCollabRefreshStale: () => stale,
}))

it("stays hidden while the collaboration mirror is fresh", () => {
  stale = false
  render(<CollabRefreshStaleBadge />)
  expect(screen.queryByTestId("collab-refresh-stale")).not.toBeInTheDocument()
})

it("shows when the last successful refresh is older than five minutes", () => {
  stale = true
  render(<CollabRefreshStaleBadge />)
  expect(screen.getByTestId("collab-refresh-stale")).toHaveTextContent("stale")
})
