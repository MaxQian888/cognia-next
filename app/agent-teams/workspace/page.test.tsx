/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react"

const replace = jest.fn()
let search = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}))

import AgentTeamsWorkspacePage from "./page"

/**
 * ADR-0140 retired this route. A redirect rather than a 404 because the id
 * survives: a bookmark, or a link inside an old message, names a team, and
 * `/squads?id=` still answers it. Dropping the id would land the reader on a
 * list and make them find it again.
 */
describe("/agent-teams/workspace", () => {
  beforeEach(() => {
    replace.mockClear()
    search = ""
  })

  it("sends a bare visit to the squad fleet", async () => {
    render(<AgentTeamsWorkspacePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/squads"))
  })

  it("carries a teamId through, the spelling the workspace route used", async () => {
    search = "teamId=squad-7"
    render(<AgentTeamsWorkspacePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/squads?id=squad-7"))
  })

  it("accepts the id spelling too", async () => {
    search = "id=squad-9"
    render(<AgentTeamsWorkspacePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/squads?id=squad-9"))
  })

  it("escapes an id that would otherwise break the query", async () => {
    search = "teamId=a%2Fb%20c"
    render(<AgentTeamsWorkspacePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/squads?id=a%2Fb%20c"))
  })
})
