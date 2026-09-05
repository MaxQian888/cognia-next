/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const mockList = jest.fn(async (): Promise<unknown[]> => [])
const mockResolve = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/issues/sync/conflicts", () => ({
  listWorkspaceSyncConflicts: (...a: unknown[]) => mockList(...(a as [])),
  resolveSyncConflict: (...a: unknown[]) => mockResolve(...a),
}))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>, _deps: unknown[], initial: unknown) => {
    const React = jest.requireActual("react") as typeof import("react")
    const [value, setValue] = React.useState(initial)
    React.useEffect(() => {
      void query().then(setValue)
    }, [query])
    return value
  },
}))

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { OpenSyncConflict } from "@/lib/issues/sync/conflicts"
import { SyncConflictsPanel } from "./sync-conflicts-panel"

const conflict: OpenSyncConflict = {
  eventId: "e1",
  issueId: "iss_1",
  ts: 1,
  provider: "github",
  field: "title",
  winner: "remote",
  localValue: "Mine",
  remoteValue: "Theirs",
}

describe("SyncConflictsPanel", () => {
  beforeEach(() => {
    mockList.mockReset()
    mockResolve.mockClear()
  })

  it("renders nothing without a workspace or without conflicts", async () => {
    mockList.mockResolvedValue([])
    const { container } = render(<SyncConflictsPanel projectId="w1" />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    const none = render(<SyncConflictsPanel projectId={null} />)
    expect(none.container).toBeEmptyDOMElement()
  })

  it("lists both values with the identifier and resolves either way", async () => {
    mockList.mockResolvedValue([conflict])
    const onOpenIssue = jest.fn()
    render(
      <SyncConflictsPanel
        projectId="w1"
        identifiersById={new Map([["iss_1", "MERC-4"]])}
        onOpenIssue={onOpenIssue}
      />
    )
    expect(await screen.findByTestId("sync-conflict-e1")).toHaveTextContent("MERC-4")
    expect(screen.getByTestId("sync-conflict-e1")).toHaveTextContent("Mine")
    expect(screen.getByTestId("sync-conflict-e1")).toHaveTextContent("Theirs")
    expect(screen.getByTestId("sync-conflict-e1")).toHaveTextContent("kept.remote")
    fireEvent.click(screen.getByText("MERC-4"))
    expect(onOpenIssue).toHaveBeenCalledWith("iss_1")
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-conflict-keep-local-e1"))
    })
    expect(mockResolve).toHaveBeenCalledWith(conflict, "local", { kind: "human" })
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-conflict-keep-remote-e1"))
    })
    expect(mockResolve).toHaveBeenLastCalledWith(conflict, "remote", { kind: "human" })
  })

  it("surfaces a failed resolution", async () => {
    mockList.mockResolvedValue([conflict])
    mockResolve.mockRejectedValueOnce(new Error("boom"))
    render(<SyncConflictsPanel projectId="w1" />)
    await screen.findByTestId("sync-conflict-e1")
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-conflict-keep-local-e1"))
    })
    expect(screen.getByRole("status")).toHaveTextContent('failed:{"reason":"boom"}')
  })
})
