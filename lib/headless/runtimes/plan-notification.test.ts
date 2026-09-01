/** @jest-environment node */
import type { HeadlessRuntimeContext } from "../types"

const installPlanNotificationActionsMock = jest.fn()
jest.mock("@/lib/agent/plan/notify", () => ({
  installPlanNotificationActions: () => installPlanNotificationActionsMock(),
}))

function makeContext(): HeadlessRuntimeContext & { log: jest.Mock } {
  return {
    host: "brain",
    accountId: "account",
    bridge: {
      listen: async () => () => undefined,
      invoke: jest.fn(),
      respondMedia: async () => {},
    },
    notifyDbWrite: jest.fn(),
    resolveMessage: (key) => key,
    log: jest.fn(),
  }
}

async function loadFresh() {
  jest.resetModules()
  const { __resetHeadlessRuntimesForTesting } = await import("../registry")
  __resetHeadlessRuntimesForTesting()
  await import("./plan-notification")
  const { bootstrapHeadlessRuntimes } = await import("../bootstrap")
  return bootstrapHeadlessRuntimes
}

beforeEach(() => {
  installPlanNotificationActionsMock.mockReset()
})

it("registers the plan.respond command in the brain and unregisters it on stop", async () => {
  const dispose = jest.fn()
  installPlanNotificationActionsMock.mockReturnValue(dispose)
  const bootstrap = await loadFresh()
  const result = await bootstrap(makeContext())

  expect(result.failed).toEqual([])
  expect(result.started).toContain("plan-notification")
  expect(installPlanNotificationActionsMock).toHaveBeenCalledTimes(1)

  await result.stop()
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("does not start on a host other than the brain", async () => {
  installPlanNotificationActionsMock.mockReturnValue(() => undefined)
  const bootstrap = await loadFresh()
  const result = await bootstrap({ ...makeContext(), host: "other" as "brain" })

  expect(result.started).not.toContain("plan-notification")
  expect(installPlanNotificationActionsMock).not.toHaveBeenCalled()
})

it("keeps the rest of the roster alive when the command cannot register", async () => {
  installPlanNotificationActionsMock.mockImplementation(() => {
    throw new Error("registry unavailable")
  })
  const bootstrap = await loadFresh()
  const context = makeContext()
  const result = await bootstrap(context)

  expect(result.started).not.toContain("plan-notification")
  expect(result.failed[0]?.name).toBe("plan-notification")
  expect(context.log).toHaveBeenCalledWith("error", expect.stringMatching(/plan-notification/))
})
