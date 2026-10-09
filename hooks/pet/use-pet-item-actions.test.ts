/** @jest-environment jsdom */
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/pet/economy/shop", () => ({
  purchaseItem: jest.fn(),
  consumeItem: jest.fn(),
}))

import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import {
  PetConsoleActionsContext,
  type PetConsoleActions,
} from "@/components/pet/console/pet-console-actions-context"
import { usePetItemActions } from "./use-pet-item-actions"

const purchaseMock = purchaseItem as jest.Mock
const consumeMock = consumeItem as jest.Mock
const success = toast.success as jest.Mock
const error = toast.error as jest.Mock

const berry = getPetItem("berry")!
const charm = getPetItem("star-charm")!

beforeEach(() => {
  purchaseMock.mockReset()
  consumeMock.mockReset()
  success.mockReset()
  error.mockReset()
})

describe("usePetItemActions", () => {
  it("toasts a purchase with the item's name", async () => {
    purchaseMock.mockResolvedValue({ ok: true, coins: 5 })
    const { result } = renderHook(() => usePetItemActions())
    await act(async () => {
      await result.current.purchase(berry)
    })
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Berry"))
  })

  it("explains a refused purchase instead of failing silently", async () => {
    purchaseMock.mockResolvedValue({ ok: false, error: "insufficient-coins" })
    const { result } = renderHook(() => usePetItemActions())
    await act(async () => {
      await result.current.purchase(berry)
    })
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/coins/i))
    expect(success).not.toHaveBeenCalled()
  })

  it("tells the user how long a cooling item has to wait", async () => {
    consumeMock.mockResolvedValue({ ok: false, error: "cooling-down", retryAfterMs: 2500 })
    const { result } = renderHook(() => usePetItemActions())
    await act(async () => {
      await result.current.use(berry)
    })
    expect(error).toHaveBeenCalledWith(expect.stringContaining("3"))
  })

  it("words a decor apply differently from a consumable use", async () => {
    consumeMock.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => usePetItemActions())
    await act(async () => {
      await result.current.use(berry)
      await result.current.use(charm)
    })
    expect(success.mock.calls[0]![0]).not.toEqual(success.mock.calls[1]![0])
  })

  it("turns a thrown write into a toast and a failed result", async () => {
    purchaseMock.mockRejectedValue(new Error("db closed"))
    const { result } = renderHook(() => usePetItemActions())
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.purchase(berry)
    })
    expect(outcome).toMatchObject({ ok: false, reason: "failed" })
    expect(error).toHaveBeenCalled()
  })

  it("marks only the running action on the running item as pending", async () => {
    let finish!: (v: unknown) => void
    purchaseMock.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const { result } = renderHook(() => usePetItemActions())
    let run!: Promise<unknown>
    act(() => {
      run = result.current.purchase(berry)
    })
    expect(result.current.isPending("buy", "berry")).toBe(true)
    expect(result.current.isPending("use", "berry")).toBe(false)
    expect(result.current.isPending("buy", "cookie")).toBe(false)
    await act(async () => {
      finish({ ok: true, coins: 0 })
      await run
    })
    expect(result.current.isPending("buy", "berry")).toBe(false)
  })

  // Inside the console the console decides: on a paired phone that is the
  // DESKTOP's shop (ADR-0219), and this device's shop must not be touched.
  it("routes through the console's actions when rendered inside the console", async () => {
    const consoleActions = {
      purchase: jest.fn().mockResolvedValue({ ok: true }),
      useItem: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as PetConsoleActions
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(PetConsoleActionsContext.Provider, { value: consoleActions }, children)
    const { result } = renderHook(() => usePetItemActions(), { wrapper })
    await act(async () => {
      await result.current.purchase(berry)
      await result.current.use(berry)
    })
    expect(consoleActions.purchase).toHaveBeenCalledWith(berry)
    expect(consoleActions.useItem).toHaveBeenCalledWith(berry)
    expect(purchaseMock).not.toHaveBeenCalled()
    expect(consumeMock).not.toHaveBeenCalled()
  })

  it("names items the way the shop lists them", () => {
    const { result } = renderHook(() => usePetItemActions())
    expect(result.current.itemTitle(berry)).toMatch(/berry/i)
  })
})
