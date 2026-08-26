/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { StackForge } from "@/lib/stack/forge-session"
import { createFakeForge } from "@/lib/stack/forge/fake"
import { mergeStack } from "@/lib/stack/merge"
import type { Stack } from "@/lib/stack/model"
import type { GitStackPushOutcome } from "@/types/git"

import { useStackForge, type UseStackForgeDeps } from "./use-stack-forge"

const STACK: Stack = {
  id: "stack:me/b",
  repositoryRoot: "/repos/app",
  trunk: "main",
  model: "branchPerLayer",
  layers: [
    { id: "me/a", branch: "me/a", title: "Layer A", order: 0 },
    { id: "me/b", branch: "me/b", title: "Layer B", order: 1 },
  ],
}

const PUSHED: GitStackPushOutcome = { pushed: ["me/a", "me/b"], forceIfIncludes: true }

function ready(adapter = createFakeForge()): StackForge {
  return { status: "ready", repository: "acme/app", remote: "origin", adapter }
}

function deps(over: Partial<UseStackForgeDeps> = {}) {
  const adapter = createFakeForge()
  const injected = {
    open: jest.fn(async () => ready(adapter)),
    push: jest.fn(async () => PUSHED),
    ...over,
  } as Partial<UseStackForgeDeps> & { open: jest.Mock; push: jest.Mock }
  return { injected, adapter }
}

describe("useStackForge", () => {
  it("costs nothing until something is published", async () => {
    // The panel opens on every repository; resolving a credential there would
    // shell out for people who never publish from this machine at all.
    const { injected } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    await waitFor(() => expect(result.current.forge).toBeNull())
    expect(injected.open).not.toHaveBeenCalled()
  })

  it("pushes the whole stack before opening any pull request", async () => {
    const { injected, adapter } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))

    let outcome: Awaited<ReturnType<typeof result.current.publish>> | null = null
    await act(async () => {
      outcome = await result.current.publish(STACK)
    })

    expect(injected.push).toHaveBeenCalledWith("/repos/app", "origin", ["me/a", "me/b"])
    expect(outcome).toMatchObject({ kind: "published" })
    // Bottom first, each based on the one below: a pull request whose base does
    // not exist yet is rejected outright.
    const opened = [...adapter.pullRequests.values()]
    expect(opened.map((pull) => [pull.branch, pull.baseBranch])).toEqual([
      ["me/a", "main"],
      ["me/b", "me/a"],
    ])
  })

  it("remembers the pull requests it opened, so the panel can link to them", async () => {
    const { injected } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    await act(async () => {
      await result.current.publish(STACK)
    })
    expect(Object.keys(result.current.pullRequests).sort()).toEqual(["me/a", "me/b"])
  })

  it("reports an unusable forge instead of throwing at a button", async () => {
    const { injected } = deps({
      open: jest.fn(
        async () =>
          ({ status: "noCredential", repository: "acme/app", remote: "origin" }) as StackForge
      ),
    })
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    let outcome: Awaited<ReturnType<typeof result.current.publish>> | null = null
    await act(async () => {
      outcome = await result.current.publish(STACK)
    })
    expect(outcome).toEqual({
      kind: "unavailable",
      forge: { status: "noCredential", repository: "acme/app", remote: "origin" },
    })
    expect(injected.push).not.toHaveBeenCalled()
  })

  it("resolves the forge once and reuses it", async () => {
    const { injected } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    await act(async () => {
      await result.current.publish(STACK)
      await result.current.publish(STACK)
    })
    expect(injected.open).toHaveBeenCalledTimes(1)
  })

  it("looks pull requests up again before merging rather than trusting the map", async () => {
    // A number cached earlier in the session outlives someone closing the pull
    // request; merging is the one place that must not act on a stale one.
    const { injected, adapter } = deps()
    const attach = jest.fn(async (stack: Stack) => stack)
    const { result } = renderHook(() =>
      useStackForge("/repos/app", { ...injected, attach: attach as never })
    )
    await act(async () => {
      await result.current.publish(STACK)
      await result.current.merge(STACK)
    })
    expect(attach).toHaveBeenCalledWith(STACK, "acme/app", adapter)
  })

  it("merges bottom first once the stack has pull requests", async () => {
    const { injected, adapter } = deps()
    // `mergeStack` restacks and re-parents the layers above each merge, which
    // is real git. Its own deps seam is what a test drives it through.
    const merge: UseStackForgeDeps["merge"] = (input) =>
      mergeStack(input, {
        setParent: async () => {},
        restack: async () => ({
          status: "upToDate",
          verdict: { ok: true, problems: [], remedy: "none" },
        }),
      })
    const { result } = renderHook(() => useStackForge("/repos/app", { ...injected, merge }))
    await act(async () => {
      await result.current.publish(STACK)
    })
    let outcome: Awaited<ReturnType<typeof result.current.merge>> | null = null
    await act(async () => {
      outcome = await result.current.merge(STACK)
    })
    expect(outcome).toMatchObject({ kind: "merged", result: { status: "merged" } })
    expect(adapter.merged.map((entry) => entry.pullRequest)).toEqual([1, 2])
  })

  it("says nothing on a pull request when nobody has connected a forge", async () => {
    // A local-only restack must not start authenticating against GitHub.
    const { injected, adapter } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    await act(async () => {
      await result.current.announce([
        {
          branch: "me/a",
          from: "a".repeat(40),
          to: "b".repeat(40),
          historyRef: "refs/cognia/stack-history/me/a/1",
        },
      ])
    })
    expect(injected.open).not.toHaveBeenCalled()
    expect(adapter.comments).toEqual([])
  })

  it("leaves the restack note on each moved layer, naming the tip it kept", async () => {
    const { injected, adapter } = deps()
    const { result } = renderHook(() => useStackForge("/repos/app", injected))
    await act(async () => {
      await result.current.publish(STACK)
    })
    await act(async () => {
      await result.current.announce([
        {
          branch: "me/b",
          from: "a".repeat(40),
          to: "b".repeat(40),
          historyRef: "refs/cognia/stack-history/me/b/17",
        },
      ])
    })
    expect(adapter.comments).toHaveLength(1)
    expect(adapter.comments[0]!.body).toContain("refs/cognia/stack-history/me/b/17")
    expect(adapter.comments[0]!.body).toContain("me/b")
  })

  it("forgets everything when the repository changes", async () => {
    const { injected } = deps()
    const { result, rerender } = renderHook(
      ({ root }: { root: string }) => useStackForge(root, injected),
      { initialProps: { root: "/repos/app" } }
    )
    await act(async () => {
      await result.current.publish(STACK)
    })
    expect(result.current.pullRequests["me/a"]).toBeDefined()

    rerender({ root: "/repos/other" })
    await waitFor(() => expect(result.current.forge).toBeNull())
    expect(result.current.pullRequests).toEqual({})
  })
})
