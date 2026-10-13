/** @jest-environment node */
import { installFakeIndexedDb } from "@/lib/headless/node-indexeddb"
import {
  forgetCollabConnection,
  loadCollabConnection,
  saveCollabConnection,
  subscribeCollabConnection,
} from "./connection"
import { installCollabNotificationsSync } from "./notifications-sync"

it("uses the real brain window shim without requiring DOM event methods", async () => {
  await installFakeIndexedDb()
  expect(window).toBe(globalThis)
  expect(window.addEventListener).toBeUndefined()
  const stopConnection = subscribeCollabConnection(jest.fn())
  saveCollabConnection("shim-account", { baseUrl: "https://collab.test" })
  expect(loadCollabConnection("shim-account")).toEqual({ baseUrl: "https://collab.test" })
  forgetCollabConnection("shim-account")
  expect(loadCollabConnection("shim-account")).toBeNull()
  stopConnection()

  const resolve = jest.fn().mockResolvedValue(null)
  const detachReads = jest.fn()
  const detachSignals = jest.fn()
  const stop = installCollabNotificationsSync("shim-account", {
    resolve,
    installReadPropagation: () => detachReads,
    subscribeSignals: () => detachSignals,
  })
  await Promise.resolve()
  expect(resolve).toHaveBeenCalledWith("shim-account")
  stop()
  expect(detachReads).toHaveBeenCalledTimes(1)
  expect(detachSignals).toHaveBeenCalledTimes(1)
})
