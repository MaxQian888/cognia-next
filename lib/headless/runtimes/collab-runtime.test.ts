/** @jest-environment node */
jest.mock("@/lib/collab/feed", () => ({ installCollabFeed: jest.fn() }))
jest.mock("@/lib/collab/notifications-sync", () => ({ installCollabNotificationsSync: jest.fn() }))
jest.mock("@/lib/collab/connection", () => ({ subscribeCollabConnection: jest.fn() }))

import { installCollabFeed } from "@/lib/collab/feed"
import { installCollabNotificationsSync } from "@/lib/collab/notifications-sync"
import { subscribeCollabConnection } from "@/lib/collab/connection"
import { listHeadlessRuntimes, registerHeadlessRuntime } from "../registry"
import type { HeadlessRuntimeContext } from "../types"
import { startCollabRuntime, type HeadlessCollabAdapter } from "./collab-runtime"

const feed = jest.mocked(installCollabFeed)
const notifications = jest.mocked(installCollabNotificationsSync)
const connection = jest.mocked(subscribeCollabConnection)
const detachFeed = jest.fn()
const detachNotifications = jest.fn()
const unsubscribe = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  feed.mockReturnValue(detachFeed)
  notifications.mockReturnValue(detachNotifications)
  connection.mockReturnValue(unsubscribe)
})

it("can reevaluate the module during development while the registry stays loaded", () => {
  const env = jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "development" })
  try {
    jest.isolateModules(() => {
      // HMR invalidates the runtime module without necessarily invalidating its registry.
      jest.doMock("../registry", () => ({ registerHeadlessRuntime }))
      expect(() => jest.requireActual("./collab-runtime")).not.toThrow()
    })
    expect(listHeadlessRuntimes().filter((entry) => entry.name === "collab-runtime")).toHaveLength(
      1
    )
    expect(feed).not.toHaveBeenCalled()
    expect(notifications).not.toHaveBeenCalled()
  } finally {
    jest.dontMock("../registry")
    env.restore()
  }
})

it("rebinds both subscriptions on connection change and tears down once", () => {
  const stop = startCollabRuntime("account")
  expect(feed).toHaveBeenCalledWith("account", undefined)
  expect(notifications).toHaveBeenCalledWith("account", undefined)
  const change = connection.mock.calls[0]![0]
  change()
  expect(detachFeed).toHaveBeenCalledTimes(1)
  expect(detachNotifications).toHaveBeenCalledTimes(1)
  expect(feed).toHaveBeenCalledTimes(2)
  stop()
  stop()
  change()
  expect(detachFeed).toHaveBeenCalledTimes(2)
  expect(detachNotifications).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(feed).toHaveBeenCalledTimes(2)
})

it("closes the feed if notification installation fails", () => {
  notifications.mockImplementationOnce(() => {
    throw new Error("storage failed")
  })
  expect(() => startCollabRuntime("account")).toThrow("storage failed")
  expect(detachFeed).toHaveBeenCalledTimes(1)
  expect(connection).not.toHaveBeenCalled()
})

it("closes installed subscriptions if the connection watcher fails", () => {
  connection.mockImplementationOnce(() => {
    throw new Error("watch failed")
  })
  expect(() => startCollabRuntime("account")).toThrow("watch failed")
  expect(detachFeed).toHaveBeenCalledTimes(1)
  expect(detachNotifications).toHaveBeenCalledTimes(1)
})

it("registers brain work using the host credentials and durable cursor adapter", async () => {
  const adapter: HeadlessCollabAdapter = {
    resolve: jest.fn().mockResolvedValue(null),
    refresh: jest.fn().mockResolvedValue(null),
    refreshAll: jest.fn().mockResolvedValue(null),
    local: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
  }
  const runtime = listHeadlessRuntimes().find((entry) => entry.name === "collab-runtime")!
  expect(runtime.criticality).toBe("optional")
  const stop = await runtime.start({
    localAccountId: "brain-account",
    collab: adapter,
  } as HeadlessRuntimeContext)
  await feed.mock.calls[0]![1]!.resolve!()
  expect(adapter.resolve).toHaveBeenCalledWith("brain-account")
  expect(feed.mock.calls[0]![1]!.refreshLegs).toBe(adapter.refresh)
  expect(notifications).toHaveBeenCalledWith("brain-account", {
    resolve: adapter.resolve,
    local: adapter.local,
  })
  await stop?.()
  expect(detachFeed).toHaveBeenCalledTimes(1)
})

it("starts no credential-less subscriptions on an unconfigured brain", async () => {
  const runtime = listHeadlessRuntimes().find((entry) => entry.name === "collab-runtime")!
  await runtime.start({ localAccountId: "brain-account" } as HeadlessRuntimeContext)
  expect(feed).not.toHaveBeenCalled()
  expect(notifications).not.toHaveBeenCalled()
})
