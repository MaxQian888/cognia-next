// Coverage for the once-per-provider-per-day over-budget toast dedupe.

const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: { warning: (...a: unknown[]) => toastWarning(...a) },
}))

import { notifyOverBudgetOnce, __resetOverBudgetToastForTesting } from "./over-budget-toast"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()
const TOMORROW = NOON + 86_400_000

const translate = jest.fn(
  (v: { provider: string; spend: string; budget: string }) =>
    `${v.provider} spent ${v.spend} of ${v.budget}`
)

beforeEach(() => {
  __resetOverBudgetToastForTesting()
  toastWarning.mockClear()
  translate.mockClear()
})

describe("notifyOverBudgetOnce", () => {
  const warning = { providerId: "openai", spend: 7.5, budget: 5 }

  it("shows the toast with formatted values on first call", () => {
    expect(notifyOverBudgetOnce(warning, translate, NOON)).toBe(true)
    expect(translate).toHaveBeenCalledWith({ provider: "openai", spend: "7.50", budget: "5.00" })
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it("dedupes repeated warnings for the same provider on the same day", () => {
    notifyOverBudgetOnce(warning, translate, NOON)
    expect(notifyOverBudgetOnce(warning, translate, NOON + 1000)).toBe(false)
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it("fires again on a new local day", () => {
    notifyOverBudgetOnce(warning, translate, NOON)
    expect(notifyOverBudgetOnce(warning, translate, TOMORROW)).toBe(true)
    expect(toastWarning).toHaveBeenCalledTimes(2)
  })

  it("tracks providers independently", () => {
    notifyOverBudgetOnce(warning, translate, NOON)
    expect(notifyOverBudgetOnce({ providerId: "groq", spend: 2, budget: 1 }, translate, NOON)).toBe(
      true
    )
  })

  it("is a no-op without a warning", () => {
    expect(notifyOverBudgetOnce(undefined, translate, NOON)).toBe(false)
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("swallows toast failures", () => {
    toastWarning.mockImplementationOnce(() => {
      throw new Error("no toaster mounted")
    })
    expect(notifyOverBudgetOnce(warning, translate, NOON)).toBe(true)
  })
})
