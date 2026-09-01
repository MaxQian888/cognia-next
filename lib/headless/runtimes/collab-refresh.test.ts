/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const requestCollabRefreshMock = jest.fn()
const collabRefreshDelayMock = jest.fn()
const getCollabRefreshStateMock = jest.fn()

jest.mock("@/lib/collab/refresh-scheduler", () => ({
  requestCollabRefresh: (accountId: string) => requestCollabRefreshMock(accountId),
  collabRefreshDelay: (failures: number) => collabRefreshDelayMock(failures),
  getCollabRefreshState: (accountId: string) => getCollabRefreshStateMock(accountId),
}))

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock } {
  return {
    host: "brain",
    accountId: "acct-1",
    bridge: { listen: async () => () => undefined, invoke: jest.fn() },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
  }
}

async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./collab-refresh")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

beforeEach(() => {
  jest.useFakeTimers()
  requestCollabRefreshMock.mockReset().mockResolvedValue({ status: "refreshed" })
  collabRefreshDelayMock.mockReset().mockReturnValue(60_000)
  getCollabRefreshStateMock.mockReset().mockReturnValue({ failures: 0 })
})

afterEach(() => {
  jest.useRealTimers()
})

it("pulls the collab plane for the brain's account on the shared backoff", async () => {
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())

  expect(result.failed).toEqual([])
  expect(result.started).toContain("collab-refresh")
  // Nothing runs at install time. The first pull is one delay away, which is
  // what keeps a brain restart loop from hammering a server that is down.
  expect(requestCollabRefreshMock).not.toHaveBeenCalled()

  await jest.advanceTimersByTimeAsync(60_000)
  expect(requestCollabRefreshMock).toHaveBeenCalledWith("acct-1")

  await result.stop()
})

/**
 * The backoff is the reason the failure count is read at scheduling time
 * rather than captured once at install. A brain whose collab server is down
 * must widen its interval, not retry every minute forever.
 */
it("re-reads the failure count for every tick", async () => {
  getCollabRefreshStateMock.mockReturnValueOnce({ failures: 0 }).mockReturnValue({ failures: 3 })
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())

  await jest.advanceTimersByTimeAsync(60_000)
  expect(collabRefreshDelayMock).toHaveBeenNthCalledWith(1, 0)
  expect(collabRefreshDelayMock).toHaveBeenNthCalledWith(2, 3)

  await result.stop()
})

it("stops pulling once the runtime is torn down", async () => {
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())
  await result.stop()

  await jest.advanceTimersByTimeAsync(300_000)
  expect(requestCollabRefreshMock).not.toHaveBeenCalled()
})

/**
 * A rejected pull must not take the loop with it. `requestCollabRefresh`
 * swallows its own failures, so a throw here is the unexpected case, and the
 * loop that stops on it is the one nobody notices for a week.
 */
it("keeps scheduling after an unexpected throw", async () => {
  requestCollabRefreshMock.mockRejectedValue(new Error("boom"))
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())

  await jest.advanceTimersByTimeAsync(60_000)
  await jest.advanceTimersByTimeAsync(60_000)
  expect(requestCollabRefreshMock).toHaveBeenCalledTimes(2)

  await result.stop()
})

it("does not start on a host other than the brain", async () => {
  const bootstrap = await loadFresh()
  const result = await bootstrap({ ...makeContext(), host: "other" as "brain" })
  expect(result.started).not.toContain("collab-refresh")
  await result.stop()
})
