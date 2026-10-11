import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/remote-host/migration/service", () => ({
  requestMigrationLease: jest.fn(async () => ({
    token: "lease",
    operations: [],
    expiresAt: Date.now() + 600_000,
  })),
  moveItems: jest.fn(),
  preflightMigration: jest.fn(),
}))

import type { PlaceNewItem } from "@/hooks/remote-host/use-place-new-item"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

import { PlaceNewItemDialog, RunsOnField } from "./new-item-placement"

const target = { id: "mini", label: "Mac mini" } as RemoteHost
const item = { ref: { kind: "scheduled-task" as const, id: "t1" }, label: "Digest" }

function placement(overrides: Partial<PlaceNewItem> = {}): PlaceNewItem {
  return {
    target,
    choice: "host",
    setChoice: jest.fn(),
    place: jest.fn(),
    placing: null,
    done: jest.fn(),
    ...overrides,
  }
}

describe("RunsOnField", () => {
  it("offers the always-on host, chosen, and this device", () => {
    const value = placement()
    render(<RunsOnField placement={value} idPrefix="task" />)
    expect(screen.getByTestId("runs-on-field")).toHaveTextContent("Mac mini (always on)")
    expect(screen.getByTestId("runs-on-host")).toHaveAttribute("data-state", "checked")
    fireEvent.click(screen.getByTestId("runs-on-here"))
    expect(value.setChoice).toHaveBeenCalledWith("here")
  })

  it("asks nothing when no always-on host is up", () => {
    const { container } = render(
      <RunsOnField placement={placement({ target: null })} idPrefix="t" />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe("PlaceNewItemDialog", () => {
  it("moves the item that was just created, on its own", async () => {
    const move = jest.fn(async () => [
      { item: item.ref, operationId: "op", ok: true, state: "completed" },
    ])
    const onChanged = jest.fn()
    render(
      <PlaceNewItemDialog
        placement={placement({ placing: item })}
        onChanged={onChanged}
        deps={{
          preflight: async () => [
            {
              item: item.ref,
              label: "Digest",
              localStatus: "active",
              ready: true,
              blockers: [],
              notes: [],
              plugins: [],
              checkedAt: 1,
            },
          ],
          move,
        }}
      />
    )
    await waitFor(() => expect(move).toHaveBeenCalledWith("mini", [item.ref], expect.anything()))
    expect(await screen.findByTestId("move-done")).toHaveTextContent("Digest now runs on Mac mini.")
    expect(onChanged).toHaveBeenCalled()
  })

  it("renders nothing until there is an item to place", () => {
    const { container } = render(<PlaceNewItemDialog placement={placement()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
