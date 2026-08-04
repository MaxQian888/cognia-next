import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DbUpgradeBlockedDialog } from "./db-upgrade-blocked-dialog"
import { dispatchDbUpgradeBlocked } from "@/lib/db/upgrade-blocked-signal"

describe("DbUpgradeBlockedDialog", () => {
  it("stays out of the way until the upgrade actually gives up", () => {
    render(<DbUpgradeBlockedDialog />)
    expect(screen.queryByTestId("db-upgrade-blocked-dialog")).not.toBeInTheDocument()
  })

  it("explains which window to close once the signal fires", () => {
    render(<DbUpgradeBlockedDialog />)

    act(() => {
      dispatchDbUpgradeBlocked({
        databaseName: "cognia",
        attempts: 20,
        connectionOwners: ["active-singleton", "target-migration:source"],
      })
    })

    expect(screen.getByTestId("db-upgrade-blocked-dialog")).toBeInTheDocument()
    expect(screen.getByText("Database upgrade blocked")).toBeInTheDocument()
    expect(screen.getByText(/Close the other windows, then reload/)).toBeInTheDocument()
    expect(screen.getByText(/active-singleton, target-migration:source/)).toBeInTheDocument()
  })

  it("offers reload as the only action", async () => {
    // jsdom locks `window.location.reload` (see lib/desktop/menu-actions.test.ts
    // and error-page.test.tsx) — assert the affordance is the sole action and
    // that clicking it doesn't throw; reload() itself no-ops here.
    render(<DbUpgradeBlockedDialog />)
    act(() => {
      dispatchDbUpgradeBlocked({ databaseName: "cognia", attempts: 20 })
    })

    const dialog = screen.getByTestId("db-upgrade-blocked-dialog")
    const reload = screen.getByTestId("db-upgrade-blocked-reload")
    expect(reload).toHaveTextContent("Reload")
    // No cancel / dismiss — the database never opened, so there is no "continue".
    expect(within(dialog).getAllByRole("button")).toEqual([reload])

    await userEvent.click(reload)
    expect(screen.getByTestId("db-upgrade-blocked-dialog")).toBeInTheDocument()
  })

  it("unsubscribes on unmount so a late signal cannot resurrect it", () => {
    const { unmount } = render(<DbUpgradeBlockedDialog />)
    unmount()

    act(() => {
      dispatchDbUpgradeBlocked({ databaseName: "cognia", attempts: 20 })
    })

    expect(screen.queryByTestId("db-upgrade-blocked-dialog")).not.toBeInTheDocument()
  })
})
