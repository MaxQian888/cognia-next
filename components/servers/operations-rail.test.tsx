/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { Operation } from "@/lib/server-ops/client"
import { OperationsRail } from "./operations-rail"

const operation = (overrides: Partial<Operation> = {}): Operation => ({
  id: "op-1",
  targetId: "staging",
  kind: "deploy",
  state: "executing",
  request: {},
  result: null,
  error: null,
  createdBy: "operator",
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:05:00.000Z",
  ...overrides,
})

/**
 * `TooltipProvider` is mounted once in `app/layout.tsx`, so production never
 * needs it here — tests render the component in isolation and must supply it.
 */
function renderRail(props: Partial<React.ComponentProps<typeof OperationsRail>> = {}) {
  const onSelect = jest.fn()
  return {
    onSelect,
    ...render(
      <TooltipProvider>
        <OperationsRail
          operations={[operation()]}
          liveEvents
          eventStreamConnected
          selectedId={null}
          onSelect={onSelect}
          {...props}
        />
      </TooltipProvider>
    ),
  }
}

it("says the fleet is live only when the stream is actually up", () => {
  const { unmount } = renderRail({ operations: [] })
  expect(screen.getByText("Live")).toBeInTheDocument()
  unmount()

  renderRail({ operations: [], eventStreamConnected: false })
  expect(screen.getByText("Reconnecting…")).toBeInTheDocument()
})

it("reports polling rather than claiming live events on a buffered transport", () => {
  // `eventStreamConnected` is meaningless where no stream can be held open, so
  // it must not be able to produce a "Live" badge.
  renderRail({ operations: [], liveEvents: false })
  expect(screen.getByText("Polling")).toBeInTheDocument()
  expect(screen.queryByText("Live")).not.toBeInTheDocument()
})

it("explains that the history is session-scoped when it is empty", () => {
  // The controller has no endpoint that lists operations, so an empty rail is
  // not evidence that the fleet is idle.
  renderRail({ operations: [] })
  expect(screen.getByText("No operations yet")).toBeInTheDocument()
})

it("selects an operation when its row is activated", async () => {
  const user = userEvent.setup()
  const { onSelect } = renderRail()

  await user.click(screen.getByRole("button", { name: /Deploy/ }))
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "op-1" }))
})

it("narrows to one target on the detail route", () => {
  renderRail({
    operations: [
      operation({ id: "op-1", targetId: "staging", kind: "deploy" }),
      operation({ id: "op-2", targetId: "production", kind: "backup" }),
    ],
    targetId: "staging",
  })

  expect(screen.getByText("Deploy")).toBeInTheDocument()
  expect(screen.queryByText("Backup")).not.toBeInTheDocument()
})

it("marks the inspected operation as current for assistive tech", () => {
  renderRail({ selectedId: "op-1" })
  expect(screen.getByRole("button", { name: /Deploy/ })).toHaveAttribute("aria-current", "true")
})
