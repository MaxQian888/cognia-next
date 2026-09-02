import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RemoteSessionsList } from "./remote-sessions-list"

interface QueryState {
  data: Array<{ id: string; title?: string }> | null
  lastSyncedAt: number | null
  error: string | null
}

const queryState: QueryState = { data: null, lastSyncedAt: null, error: null }
const useDexieFirstQueryMock = jest.fn((_opts: unknown) => queryState)
jest.mock("@/hooks/data/use-dexie-first-query", () => ({
  useDexieFirstQuery: (opts: unknown) => useDexieFirstQueryMock(opts),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: {
      orderBy: () => ({
        reverse: () => ({ limit: () => ({ toArray: async () => [] }) }),
      }),
    },
  }),
}))

beforeEach(() => {
  queryState.data = null
  queryState.lastSyncedAt = null
  queryState.error = null
  useDexieFirstQueryMock.mockClear()
})

describe("<RemoteSessionsList />", () => {
  it("renders a row per session and fires onSelect on click", async () => {
    queryState.data = [
      { id: "s1", title: "Build feature" },
      { id: "s2", title: "Fix bug" },
    ]
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<RemoteSessionsList onSelect={onSelect} />)

    const row = await screen.findByTestId("remote-session-row-s1")
    expect(screen.getByText("Build feature")).toBeInTheDocument()
    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith("s1")
  })

  it("shows the empty state when there are no sessions", () => {
    queryState.data = []
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(screen.getByTestId("remote-sessions-empty")).toBeInTheDocument()
  })

  it("shows the loading state until the live query answers", () => {
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(screen.getByTestId("remote-sessions-loading")).toBeInTheDocument()
  })

  /**
   * The rows are local. A failed background pull must not replace them with
   * an error string, which is what the RPC-in-an-effect version did offline.
   */
  it("keeps the synced rows on screen and reports a failed pull beside them", () => {
    queryState.data = [{ id: "s1", title: "Build feature" }]
    queryState.error = "offline"
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(screen.getByTestId("remote-session-row-s1")).toBeInTheDocument()
    expect(screen.getByTestId("remote-sessions-error")).toHaveTextContent(/offline/)
  })

  it("reads the synced sessions table so the list paints from the local mirror", () => {
    queryState.data = []
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(useDexieFirstQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ table: "sessions" })
    )
  })
})
