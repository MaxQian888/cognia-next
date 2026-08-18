/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const bootIssueTrackerMock = jest.fn()
jest.mock("@/lib/issues/boot", () => ({
  bootIssueTracker: (options: unknown) => bootIssueTrackerMock(options),
}))

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock } {
  return {
    host: "brain",
    accountId: "account",
    bridge: { listen: async () => () => undefined, invoke: jest.fn() },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    log: jest.fn(),
  }
}

/** Fresh registry + bootstrap + runtime module per test (module-level registration). */
async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./issue-tracker")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

beforeEach(() => {
  bootIssueTrackerMock.mockReset()
})

it("boots the issue tracker in the brain and tears it down on stop", async () => {
  const dispose = jest.fn()
  bootIssueTrackerMock.mockResolvedValue(dispose)
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())

  expect(result.failed).toEqual([])
  expect(result.started).toContain("issue-tracker")
  expect(bootIssueTrackerMock).toHaveBeenCalledTimes(1)

  await result.stop()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("re-applies the `issues` namespace the desktop gets from useTranslations", () => {
  // The desktop passes `useTranslations("issues")`, so notify keys are relative
  // to that namespace; `resolveMessage` is absolute over the same tree. Losing
  // the prefix would silently emit raw keys as notification text.
  bootIssueTrackerMock.mockResolvedValue(() => undefined)
  return loadFresh()
    .then((bootstrap) => bootstrap(makeContext()))
    .then(() => {
      const { translate } = bootIssueTrackerMock.mock.calls[0][0] as {
        translate: (key: string, values?: Record<string, string | number>) => string
      }
      expect(translate("notify.assigned")).toBe("issues.notify.assigned")
      expect(translate("notify.assigned", { who: "max" })).toBe(
        'issues.notify.assigned:{"who":"max"}'
      )
    })
})

it("keeps the rest of the roster alive when the tracker cannot boot", async () => {
  bootIssueTrackerMock.mockRejectedValue(new Error("dexie closed"))
  const bootstrap = await loadFresh()
  const context = makeContext()
  const result = await bootstrap(context)

  expect(result.started).not.toContain("issue-tracker")
  expect(result.failed).toHaveLength(1)
  expect(result.failed[0].name).toBe("issue-tracker")
  expect(context.log).toHaveBeenCalledWith("error", expect.stringMatching(/issue-tracker/))
})
