/**
 * @jest-environment jsdom
 */

const ensureDefaultCogsetOnHost = jest.fn(async () => true)
const writeThroughStop = jest.fn()
const followerStop = jest.fn()
const startDefaultCogsetWriteThrough = jest.fn(async () => ({ stop: writeThroughStop }))
const startDefaultCogsetFollower = jest.fn(async () => ({ stop: followerStop }))
let runtimeReady = true
let mirrored = false
let accountId: string | null = "acct-1"

jest.mock("@/lib/plugin/cogset/bootstrap-default", () => ({
  ensureDefaultCogsetOnHost: () => ensureDefaultCogsetOnHost(),
}))
jest.mock("@/lib/plugin/cogset/write-through", () => ({
  startDefaultCogsetWriteThrough: () => startDefaultCogsetWriteThrough(),
}))
jest.mock("@/lib/plugin/cogset/follower", () => ({
  startDefaultCogsetFollower: () => startDefaultCogsetFollower(),
}))
jest.mock("@/lib/boot/capabilities", () => ({
  isBootCapabilityReady: () => runtimeReady,
  subscribeBootCapabilities: () => () => {},
  getBootCapabilitySnapshot: () => 0,
}))
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => mirrored }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (select: (state: { unlockedAccountId: string | null }) => unknown) =>
    select({ unlockedAccountId: accountId }),
}))
jest.mock("@cognia/logging", () => ({ loggers: { plugin: { warn: jest.fn() } } }))

import { render, waitFor } from "@testing-library/react"

import { PluginCogsetInitializer } from "./plugin-cogset-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  runtimeReady = true
  mirrored = false
  accountId = "acct-1"
})

describe("PluginCogsetInitializer", () => {
  it("bootstraps Default, then starts the write-through and the follower, and stops them", async () => {
    const view = render(<PluginCogsetInitializer />)
    await waitFor(() => expect(startDefaultCogsetFollower).toHaveBeenCalled())
    expect(ensureDefaultCogsetOnHost.mock.invocationCallOrder[0]).toBeLessThan(
      startDefaultCogsetWriteThrough.mock.invocationCallOrder[0]
    )
    view.unmount()
    expect(writeThroughStop).toHaveBeenCalled()
    expect(followerStop).toHaveBeenCalled()
  })

  it.each([
    ["the plugin runtime is not ready", () => (runtimeReady = false)],
    ["no account is unlocked", () => (accountId = null)],
    ["this client mirrors a host", () => (mirrored = true)],
  ])("does nothing while %s", async (_label, arrange) => {
    arrange()
    render(<PluginCogsetInitializer />)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ensureDefaultCogsetOnHost).not.toHaveBeenCalled()
  })

  it("logs instead of throwing when cogsets cannot start", async () => {
    const { loggers } = jest.requireMock("@cognia/logging")
    ensureDefaultCogsetOnHost.mockRejectedValueOnce(new Error("db locked"))
    render(<PluginCogsetInitializer />)
    await waitFor(() =>
      expect(loggers.plugin.warn).toHaveBeenCalledWith("cogsets failed to start", {
        error: "db locked",
      })
    )
    expect(startDefaultCogsetFollower).not.toHaveBeenCalled()
  })
})
