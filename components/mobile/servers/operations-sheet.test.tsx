/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

jest.mock("@/components/servers/operations-rail", () => ({
  OperationsRail: ({
    targetId,
    onSelect,
  }: {
    targetId?: string
    onSelect: (operation: unknown) => void
  }) => (
    <button
      data-testid="operations-rail"
      data-target={targetId ?? ""}
      onClick={() => onSelect({ id: "picked" })}
    >
      rail
    </button>
  ),
}))

import type { Operation } from "@/lib/server-ops/client"

import { MobileOperationsSheet } from "./operations-sheet"

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-1",
    targetId: "srv-1",
    kind: "deploy",
    state: "executing",
    request: null,
    result: null,
    error: null,
    createdBy: "me",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  }
}

function renderSheet(props: Partial<React.ComponentProps<typeof MobileOperationsSheet>> = {}) {
  return render(
    <MobileOperationsSheet
      operations={[]}
      liveEvents
      eventStreamConnected
      onSelect={jest.fn()}
      {...props}
    />
  )
}

it("keeps the rail closed until asked", () => {
  renderSheet()
  expect(screen.queryByTestId("operations-rail")).not.toBeInTheDocument()
})

it("opens the same rail the desktop renders", async () => {
  renderSheet()
  await userEvent.click(screen.getByTestId("mobile-servers-operations"))
  expect(await screen.findByTestId("operations-rail")).toBeInTheDocument()
})

/**
 * "Still going" is `isTerminalOperation`, the predicate the rest of the
 * subsystem already reads, not a second list of the ten states written out
 * here. A finished deploy is history and belongs inside, not on the trigger.
 */
it("counts only the operations that have not reached a terminal state", () => {
  renderSheet({
    operations: [
      operation({ id: "a", state: "executing" }),
      operation({ id: "b", state: "queued" }),
      operation({ id: "c", state: "succeeded" }),
      operation({ id: "d", state: "failed" }),
      operation({ id: "e", state: "cancelled" }),
      operation({ id: "f", state: "rolled_back" }),
    ],
  })
  expect(screen.getByTestId("mobile-servers-operations")).toHaveTextContent("2")
})

it("shows no count at all when nothing is running", () => {
  renderSheet({ operations: [operation({ state: "succeeded" })] })
  const trigger = screen.getByTestId("mobile-servers-operations")
  expect(trigger).toHaveTextContent("servers.operations.title")
  expect(trigger.textContent).not.toMatch(/\d/)
})

/** On the detail route a busy fleet must not bury this target's own work. */
it("counts only the named target's work when scoped", () => {
  renderSheet({
    targetId: "srv-1",
    operations: [
      operation({ id: "a", targetId: "srv-1", state: "executing" }),
      operation({ id: "b", targetId: "srv-2", state: "executing" }),
    ],
  })
  expect(screen.getByTestId("mobile-servers-operations")).toHaveTextContent("1")
})

/**
 * The inspector is itself a sheet. Stacking one over the other leaves two
 * scrims and no way back, so this one closes before handing the pick on.
 */
it("closes itself before opening the inspector", async () => {
  const onSelect = jest.fn()
  renderSheet({ onSelect })
  await userEvent.click(screen.getByTestId("mobile-servers-operations"))
  await userEvent.click(await screen.findByTestId("operations-rail"))
  expect(onSelect).toHaveBeenCalledWith({ id: "picked" })
  expect(screen.queryByTestId("operations-rail")).not.toBeInTheDocument()
})
