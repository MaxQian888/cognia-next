import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RemoteSessionsList } from "./remote-sessions-list"

const listSessionsMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  listSessions: (...a: unknown[]) => listSessionsMock(...a),
}))

const hydrateCompanionConfigMock = jest.fn()
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: () => hydrateCompanionConfigMock(),
}))

beforeEach(() => {
  listSessionsMock.mockReset()
  hydrateCompanionConfigMock.mockReset().mockResolvedValue(null)
})

describe("<RemoteSessionsList />", () => {
  it("renders a row per session and fires onSelect on click", async () => {
    listSessionsMock.mockResolvedValue({
      rows: [
        { id: "s1", title: "Build feature" },
        { id: "s2", title: "Fix bug" },
      ],
      total: 2,
    })
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<RemoteSessionsList onSelect={onSelect} />)

    const row = await screen.findByTestId("remote-session-row-s1")
    expect(screen.getByText("Build feature")).toBeInTheDocument()
    await user.click(row)
    expect(onSelect).toHaveBeenCalledWith("s1")
  })

  it("shows the empty state when there are no sessions", async () => {
    listSessionsMock.mockResolvedValue({ rows: [], total: 0 })
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(await screen.findByTestId("remote-sessions-empty")).toBeInTheDocument()
  })

  it("surfaces a load error", async () => {
    listSessionsMock.mockRejectedValue(new Error("offline"))
    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(await screen.findByTestId("remote-sessions-error")).toHaveTextContent(/offline/)
  })

  it("waits for persisted companion config hydration before listing sessions", async () => {
    let finishHydration: (() => void) | undefined
    hydrateCompanionConfigMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHydration = resolve
        })
    )
    listSessionsMock.mockResolvedValue({ rows: [], total: 0 })

    render(<RemoteSessionsList onSelect={jest.fn()} />)
    expect(listSessionsMock).not.toHaveBeenCalled()

    await act(async () => finishHydration?.())
    expect(await screen.findByTestId("remote-sessions-empty")).toBeInTheDocument()
    expect(listSessionsMock).toHaveBeenCalledWith({ limit: 50, offset: 0 })
  })
})
