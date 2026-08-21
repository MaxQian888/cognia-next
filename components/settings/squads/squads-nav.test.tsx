/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadsNav } from "./squads-nav"

const SQUADS = [
  { id: "a", name: "Alpha", memberCount: 3 },
  { id: "b", name: "Bravo", memberCount: 0 },
]

function renderNav(over: Partial<React.ComponentProps<typeof SquadsNav>> = {}) {
  const onSelect = jest.fn()
  const onCreate = jest.fn()
  render(
    <SquadsNav
      squads={SQUADS}
      activePanel="templates"
      onSelect={onSelect}
      onCreate={onCreate}
      {...over}
    />
  )
  return { onSelect, onCreate }
}

describe("SquadsNav", () => {
  it("lists the static panel and every Squad", () => {
    renderNav()
    expect(screen.getAllByTestId("squads-nav-static")).toHaveLength(1)
    expect(screen.getAllByTestId("squads-nav-squad")).toHaveLength(2)
  })

  it("marks the active panel for assistive tech, not just visually", () => {
    renderNav({ activePanel: "squad:b" })
    const rows = screen.getAllByTestId("squads-nav-squad")
    expect(rows[1]).toHaveAttribute("aria-current", "true")
    expect(rows[0]).not.toHaveAttribute("aria-current")
  })

  it("selects by panel id, not by index", async () => {
    const { onSelect } = renderNav()
    await userEvent.click(screen.getAllByTestId("squads-nav-squad")[0]!)
    expect(onSelect).toHaveBeenCalledWith("squad:a")
  })

  it("filters the Squad list but never the way to get your first one", async () => {
    // Hiding Templates behind a non-matching query would strand a new user.
    renderNav()
    await userEvent.type(screen.getByTestId("squads-nav-search"), "alph")
    expect(screen.getAllByTestId("squads-nav-squad")).toHaveLength(1)
    expect(screen.getAllByTestId("squads-nav-static")).toHaveLength(1)
  })

  it("says 'nothing created' rather than a generic empty line", () => {
    renderNav({ squads: [] })
    expect(screen.getByTestId("squads-nav-empty")).toHaveTextContent(/No Squads yet/i)
  })

  it("says 'no match' when the list is non-empty but the query excludes it", async () => {
    renderNav()
    await userEvent.type(screen.getByTestId("squads-nav-search"), "zzzz")
    expect(screen.getByTestId("squads-nav-empty")).toHaveTextContent(/No Squad matches/i)
  })

  it("offers creation without going through the gallery", async () => {
    const { onCreate } = renderNav()
    await userEvent.click(screen.getByTestId("squads-nav-create"))
    expect(onCreate).toHaveBeenCalled()
  })

  it("shows each Squad's member count", () => {
    renderNav()
    expect(screen.getAllByTestId("squads-nav-squad")[0]).toHaveTextContent("3")
  })
})
