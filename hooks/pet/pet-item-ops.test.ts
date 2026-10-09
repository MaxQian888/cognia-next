/** @jest-environment jsdom */
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/pet/economy/shop", () => ({
  purchaseItem: jest.fn(),
  consumeItem: jest.fn(),
}))

import { toast } from "sonner"
import { consumeItem, purchaseItem } from "@/lib/pet/economy/shop"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { createLocalPetItemOps, toastPetFailure } from "./pet-item-ops"

const t = jest.fn((key: string, values?: Record<string, string | number>) =>
  values ? `${key}:${JSON.stringify(values)}` : key
)
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

describe("toastPetFailure", () => {
  it("toasts a failure in the user's words and passes the outcome through", () => {
    const outcome = {
      ok: false as const,
      reason: "refused" as const,
      message: { key: "outcomes.refusal.coolingDown", values: { seconds: 2 } },
    }
    expect(toastPetFailure(outcome, t)).toBe(outcome)
    expect(error).toHaveBeenCalledWith('outcomes.refusal.coolingDown:{"seconds":2}')
  })

  it("stays quiet for a success and for a desktop-only action the UI never offers", () => {
    toastPetFailure({ ok: true }, t)
    toastPetFailure(
      { ok: false, reason: "desktop-only", message: { key: "outcomes.remote.desktopOnly" } },
      t
    )
    expect(error).not.toHaveBeenCalled()
  })
})

describe("createLocalPetItemOps", () => {
  const ops = createLocalPetItemOps(t, "en")

  it("buys from this device's shop and names the item", async () => {
    purchaseMock.mockResolvedValue({ ok: true, coins: 3 })
    expect(await ops.purchase(berry)).toEqual({ ok: true })
    expect(purchaseMock).toHaveBeenCalledWith("berry")
    expect(success).toHaveBeenCalledWith(expect.stringContaining("outcomes.purchase.success"))
  })

  it("explains a refused purchase", async () => {
    purchaseMock.mockResolvedValue({ ok: false, error: "insufficient-coins" })
    expect(await ops.purchase(berry)).toMatchObject({ ok: false, reason: "refused" })
    expect(error).toHaveBeenCalledWith("outcomes.purchase.insufficientCoins")
  })

  it("words a consumable use and a decor apply differently", async () => {
    consumeMock.mockResolvedValue({ ok: true })
    await ops.useItem(berry)
    await ops.applyDecor(charm)
    expect(success.mock.calls[0]![0]).toContain("outcomes.use.success")
    expect(success.mock.calls[1]![0]).toContain("outcomes.apply.success")
  })

  it("turns a thrown write into a failed outcome", async () => {
    consumeMock.mockRejectedValue(new Error("db closed"))
    expect(await ops.useItem(berry)).toMatchObject({ ok: false, reason: "failed" })
    expect(error).toHaveBeenCalledWith("outcomes.failed")
  })
})
