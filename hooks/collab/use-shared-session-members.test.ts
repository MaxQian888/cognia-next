/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react"

import type { CurrentCollabContext } from "@/lib/collab/runtime-client"

import { useSharedSessionMembers } from "./use-shared-session-members"

const members = [
  {
    sessionId: "ses_1",
    userId: "usr_a",
    role: "owner",
    approver: true,
    guest: false,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    sessionId: "ses_1",
    userId: "usr_b",
    role: "viewer",
    approver: false,
    guest: false,
    createdAt: 0,
    updatedAt: 0,
  },
]

function contextFor(orgId: string, list = jest.fn(async () => members)) {
  return {
    localAccountId: "acct",
    orgId,
    userId: "usr_a",
    client: { listSessionMembers: list },
  } as unknown as CurrentCollabContext
}

describe("useSharedSessionMembers", () => {
  it("lists the conversation's members from the server", async () => {
    const list = jest.fn(async () => members)
    const resolveContext = jest.fn(async () => contextFor("org_1", list))
    const { result } = renderHook(() =>
      useSharedSessionMembers({ orgId: "org_1", sessionId: "ses_1" }, { resolveContext })
    )
    expect(result.current.loaded).toBe(false)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.members).toHaveLength(2)
    expect(result.current.selfUserId).toBe("usr_a")
    expect(list).toHaveBeenCalledWith("org_1", "ses_1")
  })

  it("answers nobody for another org, a failure or no conversation", async () => {
    const other = jest.fn(async () => contextFor("org_2"))
    const { result } = renderHook(() =>
      useSharedSessionMembers({ orgId: "org_1", sessionId: "ses_1" }, { resolveContext: other })
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.members).toEqual([])

    const failing = jest.fn(async () =>
      contextFor(
        "org_1",
        jest.fn(async () => {
          throw new Error("offline")
        })
      )
    )
    const { result: failed } = renderHook(() =>
      useSharedSessionMembers({ orgId: "org_1", sessionId: "ses_1" }, { resolveContext: failing })
    )
    await waitFor(() => expect(failed.current.loaded).toBe(true))
    expect(failed.current.members).toEqual([])

    const { result: none } = renderHook(() => useSharedSessionMembers(null))
    expect(none.current).toEqual({ loaded: true, members: [], selfUserId: null })
  })
})
