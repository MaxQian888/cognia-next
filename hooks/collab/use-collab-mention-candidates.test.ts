/** @jest-environment jsdom */

jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: jest.fn(async () => null),
}))

import { renderHook, waitFor } from "@testing-library/react"

import type { CurrentCollabContext } from "@/lib/collab/runtime-client"
import {
  toMentionCandidates,
  useCollabMentionCandidates,
  type CollabMentionScope,
} from "./use-collab-mention-candidates"

const ME = "usr_me"
const SCOPE: CollabMentionScope = { orgId: "org_1", workspaceId: "ws_1" }

function context(
  listWorkspaceMembers: jest.Mock,
  overrides: Partial<CurrentCollabContext> = {}
): CurrentCollabContext {
  return {
    localAccountId: "local",
    orgId: "org_1",
    userId: ME,
    client: { listWorkspaceMembers } as unknown as CurrentCollabContext["client"],
    ...overrides,
  }
}

const ROSTER = [
  { userId: "usr_cat", displayName: "Cat", role: "member", orgMember: true },
  { userId: ME, displayName: "Me", role: "maintainer", orgMember: true },
  { userId: "usr_ada", displayName: "Ada", role: "member", orgMember: true },
]

describe("toMentionCandidates", () => {
  it("drops the writer, de-duplicates and sorts by name", () => {
    expect(
      toMentionCandidates(
        [
          ...ROSTER,
          { userId: "usr_ada", displayName: "Ada again" },
          { userId: "", displayName: "x" },
        ],
        ME
      )
    ).toEqual([
      { userId: "usr_ada", displayName: "Ada" },
      { userId: "usr_cat", displayName: "Cat" },
    ])
  })

  it("falls back to the id for a blank display name", () => {
    expect(toMentionCandidates([{ userId: "usr_x", displayName: "  " }], ME)).toEqual([
      { userId: "usr_x", displayName: "usr_x" },
    ])
  })
})

describe("useCollabMentionCandidates", () => {
  it("loads the workspace roster from the server, without the writer", async () => {
    const list = jest.fn(async () => ROSTER)
    const resolveContext = jest.fn(async () => context(list))
    const { result } = renderHook(() => useCollabMentionCandidates(SCOPE, { resolveContext }))

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(list).toHaveBeenCalledWith("org_1", "ws_1")
    expect(result.current.map((candidate) => candidate.userId)).toEqual(["usr_ada", "usr_cat"])
  })

  it("offers nobody without a scope, and asks nobody", async () => {
    const resolveContext = jest.fn(async () => null)
    const { result } = renderHook(() => useCollabMentionCandidates(null, { resolveContext }))
    expect(result.current).toEqual([])
    await Promise.resolve()
    expect(resolveContext).not.toHaveBeenCalled()
  })

  it("offers nobody when collaboration is not configured", async () => {
    const resolveContext = jest.fn(async () => null)
    const { result } = renderHook(() => useCollabMentionCandidates(SCOPE, { resolveContext }))
    await waitFor(() => expect(resolveContext).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })

  it("offers nobody when the roster request fails (offline, revoked read)", async () => {
    const list = jest.fn(async () => {
      throw new Error("network down")
    })
    const resolveContext = jest.fn(async () => context(list))
    const { result } = renderHook(() => useCollabMentionCandidates(SCOPE, { resolveContext }))
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(result.current).toEqual([])
  })

  it("offers nobody for an issue mirrored under another org", async () => {
    const list = jest.fn(async () => ROSTER)
    const resolveContext = jest.fn(async () => context(list, { orgId: "org_other" }))
    const { result } = renderHook(() => useCollabMentionCandidates(SCOPE, { resolveContext }))
    await waitFor(() => expect(resolveContext).toHaveBeenCalled())
    expect(list).not.toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it("never shows the previous workspace's roster against the next one", async () => {
    let release: (value: typeof ROSTER) => void = () => {}
    const list = jest
      .fn()
      .mockResolvedValueOnce(ROSTER)
      .mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const resolveContext = jest.fn(async () => context(list))
    const { result, rerender } = renderHook(
      ({ scope }: { scope: CollabMentionScope }) =>
        useCollabMentionCandidates(scope, { resolveContext }),
      { initialProps: { scope: SCOPE } }
    )
    await waitFor(() => expect(result.current).toHaveLength(2))

    rerender({ scope: { orgId: "org_1", workspaceId: "ws_2" } })
    expect(result.current).toEqual([])

    release([{ userId: "usr_bob", displayName: "Bob", role: "member", orgMember: true }])
    await waitFor(() => expect(result.current).toEqual([{ userId: "usr_bob", displayName: "Bob" }]))
    expect(list).toHaveBeenLastCalledWith("org_1", "ws_2")
  })
})
