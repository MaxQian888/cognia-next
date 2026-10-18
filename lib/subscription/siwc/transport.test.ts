import { transport } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import {
  beginSiwcLogin,
  cancelSiwcLogin,
  deleteSiwcConnection,
  listSiwcConnections,
  listSiwcModels,
  pollSiwcLogin,
  refreshSiwcConnection,
  signOutSiwcConnection,
} from "./transport"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn() },
}))

const call = jest.mocked(transport.call)
const account = jest.mocked(useAccountStore.getState)
const subscribe = jest.mocked(useAccountStore.subscribe)
const unsubscribe = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  account.mockReturnValue({ unlockedAccountId: "local-a" } as ReturnType<typeof account>)
  subscribe.mockReturnValue(unsubscribe)
  call.mockResolvedValue(undefined)
})

it("lists without bootstrapping, synchronizing, or reading legacy credentials", async () => {
  call.mockResolvedValue([])
  await expect(listSiwcConnections()).resolves.toEqual([])
  expect(call.mock.calls).toEqual([["siwc_list_connections", { localAccountId: "local-a" }]])
})

it("requires an unlocked local account before any command", async () => {
  account.mockReturnValue({ unlockedAccountId: null } as ReturnType<typeof account>)
  await expect(beginSiwcLogin()).rejects.toThrow("unlocked")
  expect(call).not.toHaveBeenCalled()
})

it("pins every operation to its unlocked local account", async () => {
  await beginSiwcLogin("registration-a")
  await pollSiwcLogin("attempt-a")
  await refreshSiwcConnection("registration-a")
  await signOutSiwcConnection("registration-a")
  await deleteSiwcConnection("registration-a")
  await listSiwcModels("registration-a")
  expect(call.mock.calls).toEqual([
    ["siwc_begin_login", { localAccountId: "local-a", connectionId: "registration-a" }],
    ["siwc_poll_login", { localAccountId: "local-a", attemptId: "attempt-a" }],
    ["siwc_refresh_connection", { localAccountId: "local-a", connectionId: "registration-a" }],
    ["siwc_sign_out", { localAccountId: "local-a", connectionId: "registration-a" }],
    ["siwc_delete_connection", { localAccountId: "local-a", connectionId: "registration-a" }],
    ["siwc_list_models", { localAccountId: "local-a", connectionId: "registration-a" }],
  ])
})

it("rejects a response that finishes after switching local accounts", async () => {
  let finish!: (value: unknown) => void
  call.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }) as never
  )
  const pending = listSiwcConnections()
  account.mockReturnValue({ unlockedAccountId: "local-b" } as ReturnType<typeof account>)
  finish([])
  await expect(pending).rejects.toThrow("changed")
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it("rejects an ABA account switch and cancels its late login attempt", async () => {
  let finish!: (value: unknown) => void
  call.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }) as never
  )
  const pending = beginSiwcLogin()
  const listener = subscribe.mock.calls[0][0]
  listener({ unlockedAccountId: "local-b" } as never, { unlockedAccountId: "local-a" } as never)
  listener({ unlockedAccountId: "local-a" } as never, { unlockedAccountId: "local-b" } as never)
  finish({ attemptId: "stale-attempt" })
  await expect(pending).rejects.toThrow("changed")
  expect(call).toHaveBeenLastCalledWith("siwc_cancel_login", {
    localAccountId: "local-a",
    attemptId: "stale-attempt",
  })
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it("cancels an old attempt in its original scope after lock or switch", async () => {
  account.mockReturnValue({ unlockedAccountId: "local-b" } as ReturnType<typeof account>)
  await cancelSiwcLogin("attempt-a", "local-a")
  expect(call).toHaveBeenCalledWith("siwc_cancel_login", {
    localAccountId: "local-a",
    attemptId: "attempt-a",
  })
})

it.each(["", " ", "\n"])("rejects an empty native reference %p", async (reference) => {
  await expect(pollSiwcLogin(reference)).rejects.toThrow("reference")
  await expect(beginSiwcLogin(reference)).rejects.toThrow("reference")
  await expect(refreshSiwcConnection(reference)).rejects.toThrow("reference")
  await expect(cancelSiwcLogin("attempt-a", reference)).rejects.toThrow("reference")
  expect(call).not.toHaveBeenCalled()
})
