/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { Stack } from "@/lib/stack/model"
import type { RestackStackResult } from "@/lib/stack/restack"
import type { GitStackLayerState } from "@/types/git"

import { useStacks, type UseStacksDeps } from "./use-stacks"

const STACK: Stack = {
  id: "stack:me/b",
  repositoryRoot: "/repos/app",
  trunk: "main",
  model: "branchPerLayer",
  layers: [
    { id: "me/a", branch: "me/a", title: "me/a", order: 0 },
    { id: "me/b", branch: "me/b", title: "me/b", order: 1 },
  ],
}

function state(over: Partial<GitStackLayerState> & { branch: string }): GitStackLayerState {
  return {
    parent: null,
    head: "0".repeat(40),
    containsParent: true,
    checkedOutIn: null,
    ...over,
  }
}

function deps(over: Partial<UseStacksDeps> = {}): UseStacksDeps & {
  discover: jest.Mock
  validate: jest.Mock
  restack: jest.Mock
  setParent: jest.Mock
  history: jest.Mock
  revert: jest.Mock
} {
  return {
    discover: jest.fn(async () => [STACK]),
    validate: jest.fn(async () => [
      state({ branch: "me/a", parent: "main" }),
      state({ branch: "me/b", parent: "me/a" }),
    ]),
    restack: jest.fn(async (): Promise<RestackStackResult> => ({
      status: "restacked",
      verdict: { ok: false, problems: [], remedy: "restack" },
      method: "replay",
      updates: [],
    })),
    setParent: jest.fn(async () => {}),
    history: jest.fn(async () => [] as Array<[string, string]>),
    revert: jest.fn(async () => "0".repeat(40)),
    ...over,
  } as never
}

describe("useStacks", () => {
  it("reads git rather than a cache, and validates each stack it finds", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(injected.discover).toHaveBeenCalledWith("/repos/app")
    expect(injected.validate).toHaveBeenCalledWith("/repos/app", ["me/a", "me/b"])
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]!.verdict.ok).toBe(true)
  })

  it("reports the layer that is behind rather than a bare failure", async () => {
    const injected = deps({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a", containsParent: false }),
      ]),
    })
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows[0]!.verdict.problems).toEqual([
      { kind: "behindParent", branch: "me/b", parent: "me/a" },
    ])
    expect(result.current.rows[0]!.verdict.remedy).toBe("restack")
  })

  it("re-reads after a restack, including one that conflicted", async () => {
    // A conflicted restack moved some layers. A panel that keeps showing the
    // pre-restack state claims nothing happened.
    const injected = deps({
      restack: jest.fn(async (): Promise<RestackStackResult> => ({
        status: "conflict",
        verdict: { ok: false, problems: [], remedy: "restack" },
        branch: "me/b",
        worktree: "/w",
        updates: [],
      })),
    })
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(injected.discover).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.restack(STACK)
    })
    await waitFor(() => expect(injected.discover).toHaveBeenCalledTimes(2))
    expect(result.current.lastResult?.status).toBe("conflict")
  })

  it("records a parent, which is how a stack gets built at all", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setParent("me/c", "me/b")
    })
    expect(injected.setParent).toHaveBeenCalledWith("/repos/app", "me/c", "me/b")
    await waitFor(() => expect(injected.discover).toHaveBeenCalledTimes(2))
  })

  it("clears a parent when asked to unstack", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setParent("me/b", null)
    })
    expect(injected.setParent).toHaveBeenCalledWith("/repos/app", "me/b", null)
  })

  it("carries each layer's pinned tips, so an undo survives a reload", async () => {
    // The restack that needs undoing is the one whose damage you notice after
    // closing the panel. An affordance that only lives in that restack's toast
    // is not an undo.
    const injected = deps({
      history: jest.fn(async (_root: string, branch: string) =>
        branch === "me/b"
          ? ([["refs/cognia/stack-history/me/b/1700", "a".repeat(40)]] as Array<[string, string]>)
          : []
      ),
    })
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows[0]!.history).toEqual({
      "me/a": [],
      "me/b": [{ ref: "refs/cognia/stack-history/me/b/1700", oid: "a".repeat(40) }],
    })
  })

  it("still shows the stack when the pinned tips cannot be read", async () => {
    const injected = deps({
      history: jest.fn(async () => {
        throw new Error("no git bridge")
      }),
    })
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]!.history).toEqual({ "me/a": [], "me/b": [] })
  })

  it("puts a branch back on a pinned tip and re-reads", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.undo("me/b", "refs/cognia/stack-history/me/b/1700")
    })
    expect(injected.revert).toHaveBeenCalledWith(
      "/repos/app",
      "me/b",
      "refs/cognia/stack-history/me/b/1700"
    )
    await waitFor(() => expect(injected.discover).toHaveBeenCalledTimes(2))
  })

  it("passes the remote and the announcer straight through to the restack", async () => {
    // A stack with open pull requests must be pushed after a restack, or the
    // pull requests show commits that no longer exist. The panel decides that;
    // the hook must not quietly drop either half.
    const injected = deps()
    const announce = jest.fn(async () => {})
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.restack(STACK, { remote: "origin", announce })
    })
    expect(injected.restack).toHaveBeenCalledWith(STACK, { remote: "origin", announce })
  })

  it("restacks locally when given no options at all", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.restack(STACK)
    })
    expect(injected.restack).toHaveBeenCalledWith(STACK, {})
  })

  it("reads nothing without a repository", async () => {
    const injected = deps()
    const { result } = renderHook(() => useStacks(null, injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(injected.discover).not.toHaveBeenCalled()
    expect(result.current.rows).toEqual([])
  })

  it("shows an empty list rather than nothing when git cannot be read", async () => {
    const injected = deps({
      discover: jest.fn(async () => {
        throw new Error("not a repository")
      }),
    })
    const { result } = renderHook(() => useStacks("/repos/app", injected))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows).toEqual([])
  })
})
