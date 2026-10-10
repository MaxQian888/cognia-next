import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

jest.mock("@/lib/share/session-links", () => ({
  listLiveShareLinksForSessions: jest.fn(),
  revokeShareLinksForSessions: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/data", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    // Resolves the async query the way the live query would, one tick later.
    useClientLiveQuery: <T,>(query: () => Promise<T>, deps: unknown[], initial: T): T => {
      const [value, setValue] = react.useState<T>(initial)
      react.useEffect(() => {
        let alive = true
        void query().then((next) => {
          if (alive) setValue(next)
        })
        return () => {
          alive = false
        }
      }, deps)
      return value
    },
  }
})

import {
  listLiveShareLinksForSessions,
  revokeShareLinksForSessions,
} from "@/lib/share/session-links"
import { toast } from "sonner"

import { RevokeShareLinksOption, useRevokeShareLinksAfterDelete } from "./revoke-share-links-option"

const listMock = listLiveShareLinksForSessions as jest.Mock
const revokeMock = revokeShareLinksForSessions as jest.Mock

function Harness({ sessionIds }: { sessionIds: string[] }) {
  const [checked, setChecked] = useState(false)
  return (
    <>
      <RevokeShareLinksOption
        sessionIds={sessionIds}
        checked={checked}
        onCheckedChange={setChecked}
      />
      <output data-testid="state">{String(checked)}</output>
    </>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("RevokeShareLinksOption", () => {
  it("offers to revoke the working links of the conversations being deleted", async () => {
    const user = userEvent.setup()
    listMock.mockResolvedValue([{ code: "A" }, { code: "B" }])
    render(<Harness sessionIds={["s1", "s2"]} />)
    const option = await screen.findByRole("checkbox", { name: /Also revoke 2 share links/ })
    expect(listMock).toHaveBeenCalledWith(["s1", "s2"])
    expect(option).not.toBeChecked()
    await user.click(option)
    expect(screen.getByTestId("state")).toHaveTextContent("true")
  })

  it("is not shown when nothing was shared", async () => {
    listMock.mockResolvedValue([])
    render(<Harness sessionIds={["s1"]} />)
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    expect(screen.queryByTestId("revoke-share-links-option")).toBeNull()
  })
})

describe("useRevokeShareLinksAfterDelete", () => {
  const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

  it("reports what it revoked", async () => {
    revokeMock.mockResolvedValue({ revoked: 2, failed: 0 })
    const { result } = renderHook(() => useRevokeShareLinksAfterDelete())
    result.current(["s1"])
    await flush()
    expect(revokeMock).toHaveBeenCalledWith(["s1"])
    expect(toast.success).toHaveBeenCalledWith("Revoked 2 share links.")
  })

  it("names the links it could not revoke, and where to finish", async () => {
    revokeMock.mockResolvedValue({ revoked: 1, failed: 2 })
    const { result } = renderHook(() => useRevokeShareLinksAfterDelete())
    result.current(["s1"])
    await flush()
    expect(toast.error).toHaveBeenCalledWith(
      "2 share links could not be revoked. Finish in My shares."
    )
  })

  it("says so when the links could not even be listed", async () => {
    revokeMock.mockRejectedValue(new Error("idb closed"))
    const { result } = renderHook(() => useRevokeShareLinksAfterDelete())
    result.current(["s1"])
    await flush()
    expect(toast.error).toHaveBeenCalledWith(
      "The share links could not be revoked. Finish in My shares."
    )
  })

  it("stays quiet when there was nothing to revoke", async () => {
    revokeMock.mockResolvedValue({ revoked: 0, failed: 0 })
    const { result } = renderHook(() => useRevokeShareLinksAfterDelete())
    result.current(["s1"])
    await flush()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
