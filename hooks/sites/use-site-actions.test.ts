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
  await waitFor(() => expect(result.current.busy).toBe("deploy"))
  expect(result.current.isBusy("deploy")).toBe(true)
  expect(result.current.isBusy("build")).toBe(false)
  expect(result.current.isBusy()).toBe(true)

  await act(async () => {
    release("deployed")
    await outcome
  })
  await expect(outcome).resolves.toBe("deployed")
  expect(result.current.busy).toBeNull()
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
  expect(result.current.busy).toBeNull()
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
