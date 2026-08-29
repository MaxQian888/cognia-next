import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/sites/cloudflare/service", () => ({
  CloudflareSitesService: jest.fn(function (this: Record<string, unknown>, options: unknown) {
    this.options = options
  }),
}))

import { toast } from "sonner"
import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"
import { useSiteActions } from "./use-site-actions"

const successToast = toast.success as jest.Mock
const errorToast = toast.error as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

it("builds a fresh actor-bound service on every call", () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  const first = result.current.service()
  const second = result.current.service()
  expect(first).not.toBe(second)
  expect(CloudflareSitesService).toHaveBeenCalledWith({ actorAccountId: "account_1" })
})

it("tracks the running action, returns its value, and toasts success", async () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  let release: (value: string) => void = () => {}
  const pending = new Promise<string>((resolve) => {
    release = resolve
  })

  let outcome: Promise<string | undefined> = Promise.resolve(undefined)
  act(() => {
    outcome = result.current.run("deploy", () => pending)
  })
  await waitFor(() => expect(result.current.isBusy("deploy")).toBe(true))
  expect(result.current.busyKeys.has("deploy")).toBe(true)
  // The whole point of the per-key model: an unrelated control stays live.
  expect(result.current.isBusy("build")).toBe(false)
  expect(result.current.isBusy()).toBe(false)

  await act(async () => {
    release("deployed")
    await outcome
  })
  await expect(outcome).resolves.toBe("deployed")
  expect(result.current.busyKeys.size).toBe(0)
  expect(successToast).toHaveBeenCalledWith("t:feedback.success")
})

it("reports a failure through the toast and resolves undefined", async () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  let outcome: Promise<unknown> = Promise.resolve()
  await act(async () => {
    outcome = result.current.run("build", async () => {
      throw new Error("install failed")
    })
    await outcome
  })
  await expect(outcome).resolves.toBeUndefined()
  expect(errorToast).toHaveBeenCalledWith("install failed")
  expect(successToast).not.toHaveBeenCalled()
  expect(result.current.busyKeys.size).toBe(0)
})

it("stringifies a non-Error rejection", async () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  await act(async () => {
    await result.current.run("build", async () => {
      throw "provider exploded"
    })
  })
  expect(errorToast).toHaveBeenCalledWith("provider exploded")
})

it("honours a custom success message and a silent run", async () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  await act(async () => {
    await result.current.run("logs", async () => "ok", { successMessage: "loaded" })
  })
  expect(successToast).toHaveBeenCalledWith("loaded")

  successToast.mockClear()
  await act(async () => {
    await result.current.run("logs", async () => "ok", { successMessage: null })
  })
  expect(successToast).not.toHaveBeenCalled()
})

it("refuses a second run for a key already in flight", async () => {
  // The old implementation claimed single-flight in its docstring and did not
  // implement it: both calls ran, and whichever finished first cleared the
  // flag for the other.
  const { result } = renderHook(() => useSiteActions("account_1"))
  const action = jest.fn(
    () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), 0))
  )

  let first: Promise<string | undefined> = Promise.resolve(undefined)
  let second: Promise<string | undefined> = Promise.resolve("sentinel")
  act(() => {
    first = result.current.run("build", action)
    second = result.current.run("build", action)
  })
  await act(async () => {
    await Promise.all([first, second])
  })

  expect(action).toHaveBeenCalledTimes(1)
  await expect(second).resolves.toBeUndefined()
  // A double-click is not a second intention — it must not toast twice either.
  expect(errorToast).not.toHaveBeenCalled()
  expect(successToast).toHaveBeenCalledTimes(1)
})

it("lets different keys run at the same time", async () => {
  const { result } = renderHook(() => useSiteActions("account_1"))
  let releaseBuild: () => void = () => {}
  const build = new Promise<void>((resolve) => {
    releaseBuild = resolve
  })

  act(() => {
    void result.current.run("build", () => build)
  })
  await waitFor(() => expect(result.current.isBusy("build")).toBe(true))

  const domain = jest.fn(async () => "added")
  let outcome: Promise<string | undefined> = Promise.resolve(undefined)
  await act(async () => {
    outcome = result.current.run("domain", domain)
    await outcome
  })
  expect(domain).toHaveBeenCalledTimes(1)
  await expect(outcome).resolves.toBe("added")

  await act(async () => {
    releaseBuild()
  })
})

it("an exclusive action disables every key, not just its own", async () => {
  // Purge, takedown, restore, and metadata deletion change what every other
  // control would act on.
  const { result } = renderHook(() => useSiteActions("account_1"))
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })

  act(() => {
    void result.current.run("purge", () => pending, { exclusive: true })
  })
  await waitFor(() => expect(result.current.isBusy()).toBe(true))
  expect(result.current.isBusy("build")).toBe(true)
  expect(result.current.isBusy("domain")).toBe(true)

  await act(async () => {
    release()
  })
  await waitFor(() => expect(result.current.isBusy()).toBe(false))
  expect(result.current.isBusy("build")).toBe(false)
})
