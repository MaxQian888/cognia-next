/** @jest-environment jsdom */

import { render } from "@testing-library/react"

const replace = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }))

import AgentTeamsSettingsPage from "./page"

describe("/me/agent-teams-settings", () => {
  /**
   * The page this replaces was a `PairedOnly` read-only template list, on the
   * ADR-0056 D6 reasoning that agent teams were a desktop-collaboration runtime
   * a phone could only watch. ADR-0140 made a Squad host-neutral: `/squads`
   * declares `standalone: "full"`, carries no `isTauri` gate, and shows strictly
   * more, including the fleet a phone opens this for.
   */
  it("sends a phone to the Squad fleet", () => {
    render(<AgentTeamsSettingsPage />)
    expect(replace).toHaveBeenCalledWith("/squads")
  })

  /** A redirect, not a deletion: the Me row and any bookmark still name it. */
  it("renders nothing of its own", () => {
    const { container } = render(<AgentTeamsSettingsPage />)
    expect(container).toBeEmptyDOMElement()
  })
})
