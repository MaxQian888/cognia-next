import { act, renderHook, waitFor } from "@testing-library/react"
import { createScmHost } from "@/lib/scm/host"
import { createScmRuntime } from "@/lib/scm/runtime"
import {
  makeChangeset,
  makeHost,
  makeIntegration,
  makeReview,
} from "@/components/source-control/agent-changes/test-fixtures"
import { useAgentChangesets } from "./use-agent-changesets"

jest.mock("@/lib/scm/runtime", () => ({ createScmRuntime: jest.fn() }))
jest.mock("@/lib/scm/host", () => ({
  ...jest.requireActual("@/lib/scm/host"),
  createScmHost: jest.fn(),
}))

function setup(host = makeHost(), rootDir = "/repo/") {
  const hook = renderHook(() =>
    useAgentChangesets({ rootDir, projectId: null, appSettings: null, host })
  )
  return { ...hook, host }
}

beforeEach(() => jest.clearAllMocks())

it("normalizes roots and filters integrations by the matching changesets' common dirs", async () => {
  const matching = makeChangeset({ sourceRoot: "/repo/./" })
  const other = makeChangeset({ changesetId: "other", sourceRoot: "/repo-other" })
  const run = makeIntegration({ repoCommonDir: "/repo/.git/" })
  const { result } = setup(
    makeHost([matching, other], [run, makeIntegration({ repoCommonDir: "/else/.git" })])
  )
  expect(result.current.loading).toBe(true)
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.changesets).toEqual([matching])
  expect(result.current.integrations).toEqual([run])
})

it("refreshes explicitly and on window focus", async () => {
  const { result, host } = setup()
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.refresh())
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  expect(host.listChangesets).toHaveBeenCalledTimes(3)
})

it("loads through a stable default host", async () => {
  const host = makeHost()
  jest.mocked(createScmHost).mockReturnValue(host)
  const { result, rerender } = renderHook(() =>
    useAgentChangesets({ rootDir: "/repo", projectId: null, appSettings: null })
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  rerender()
  expect(createScmHost).toHaveBeenCalledTimes(1)
})

it("records approval and request-changes at the viewed head, then refreshes every mutation", async () => {
  const changeset = makeChangeset({ review: makeReview() })
  const { result, host } = setup(makeHost([changeset]))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.approve(changeset))
  expect(host.recordChangesetReview).toHaveBeenCalledWith(
    "cs-1",
    expect.objectContaining({ headSha: changeset.headSha, reviewer: "user", verdict: "approve" })
  )
  expect(host.approveChangeset).toHaveBeenCalledWith("cs-1", changeset.headSha, "user")
  await act(() => result.current.requestChanges(changeset, "Add validation tests"))
  expect(host.recordChangesetReview).toHaveBeenLastCalledWith(
    "cs-1",
    expect.objectContaining({
      verdict: "requestChanges",
      findings: [{ path: "", severity: "critical", note: "Add validation tests" }],
    })
  )
  await act(() => result.current.abandon("cs-1"))
  await act(() => result.current.rollback("run-1"))
  await act(() => result.current.abort("run-1"))
  expect(host.abandonChangeset).toHaveBeenCalledWith("cs-1")
  expect(host.rollbackIntegration).toHaveBeenCalledWith("run-1")
  expect(host.abortIntegration).toHaveBeenCalledWith("run-1")
  expect(host.listChangesets).toHaveBeenCalledTimes(6)
})

it("wires runtime actions to the project, settings, host and abort signal", async () => {
  const host = makeHost()
  const review = jest.fn().mockResolvedValue({ changeset: makeChangeset() })
  const integrate = jest.fn().mockResolvedValue({ kind: "published" })
  jest.mocked(createScmRuntime).mockReturnValue({ host, review, integrate })
  const { result, unmount } = renderHook(() =>
    useAgentChangesets({ rootDir: "/repo", projectId: "project-1", appSettings: null, host })
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.review("cs-1"))
  const input = {
    changesetIds: ["cs-1"],
    targetRef: "refs/heads/main",
    strategy: "merge" as const,
    onConflict: "skip" as const,
    requiredChecks: ["unit"],
  }
  await act(() => result.current.integrate(input))
  expect(createScmRuntime).toHaveBeenCalledWith({ projectId: "project-1", appSettings: null, host })
  expect(review).toHaveBeenCalledWith("cs-1", expect.any(AbortSignal))
  expect(integrate).toHaveBeenCalledWith({ ...input, signal: expect.any(AbortSignal) })
  expect(host.listChangesets).toHaveBeenCalledTimes(3)
  unmount()
})

it("reports load failures and recovers on retry; mutation failures still refresh", async () => {
  const host = makeHost()
  host.listChangesets.mockRejectedValueOnce(new Error("offline"))
  const { result } = setup(host)
  await waitFor(() => expect(result.current.error?.kind).toBe("load"))
  await act(() => result.current.refresh())
  expect(result.current.error).toBeNull()
  host.abandonChangeset.mockRejectedValueOnce({ code: "stale_head" })
  await act(() => result.current.abandon("cs-1"))
  expect(result.current.error).toMatchObject({ kind: "action", code: "stale_head" })
  expect(result.current.busy).toBe(false)
  expect(host.listChangesets).toHaveBeenCalledTimes(3)
})

it("ignores a late response after switching repositories", async () => {
  const host = makeHost()
  let resolveOld!: (value: ReturnType<typeof makeChangeset>[]) => void
  host.listChangesets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  const { result, rerender } = renderHook(
    ({ rootDir }) => useAgentChangesets({ rootDir, projectId: null, appSettings: null, host }),
    { initialProps: { rootDir: "/repo" } }
  )
  await waitFor(() => expect(host.listChangesets).toHaveBeenCalledTimes(1))
  host.listChangesets.mockResolvedValue([makeChangeset({ sourceRoot: "/new", changesetId: "new" })])
  rerender({ rootDir: "/new" })
  await waitFor(() => expect(result.current.changesets[0]?.changesetId).toBe("new"))
  await act(async () => resolveOld([makeChangeset()]))
  expect(result.current.changesets[0].changesetId).toBe("new")
})

it("prevents duplicate mutations and aborts a runtime operation on unmount", async () => {
  const host = makeHost()
  let finish!: () => void
  const review = jest.fn(
    () =>
      new Promise<never>((resolve) => {
        finish = () => resolve(undefined as never)
      })
  )
  jest.mocked(createScmRuntime).mockReturnValue({ host, review, integrate: jest.fn() })
  const { result, unmount } = setup(host)
  await waitFor(() => expect(result.current.loading).toBe(false))
  let operation!: ReturnType<typeof result.current.review>
  await act(async () => {
    operation = result.current.review("cs-1")
  })
  await waitFor(() => expect(review).toHaveBeenCalledTimes(1))
  await act(() => result.current.abandon("cs-1"))
  expect(host.abandonChangeset).not.toHaveBeenCalled()
  const signal = jest.mocked(createScmRuntime).mock.results[0].value.review.mock
    .calls[0][1] as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => {
    finish()
    await operation
  })
  expect(host.listChangesets).toHaveBeenCalledTimes(1)
})
