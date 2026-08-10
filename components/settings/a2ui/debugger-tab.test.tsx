/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { DebuggerTab } from "./debugger-tab"

const listEvents = jest.fn(async () => [
  {
    id: "event-1",
    surfaceId: "surface-a",
    type: "userAction" as const,
    payload: { action: "submit" },
    timestamp: 1,
  },
])

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/db/a2ui-event-history", () => ({
  listEvents: () => listEvents(),
  clearEvents: jest.fn(),
  appendEvent: jest.fn(),
}))
jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: jest.fn(() => jest.fn()),
    onDataChange: jest.fn(() => jest.fn()),
  },
}))
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: { surfaces: Record<string, unknown> }) => unknown) =>
    selector({ surfaces: {} }),
}))

it("selects a debugger event through the shared Button primitive", async () => {
  render(<DebuggerTab />)

  const surface = await screen.findByText("surface-a")
  const row = surface.closest("button")
  expect(row).toHaveAttribute("data-slot", "button")

  fireEvent.click(row!)
  expect(screen.getByText(/"action": "submit"/)).toBeInTheDocument()
})
