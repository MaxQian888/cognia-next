// Coverage for the once-per-capability+model dropped-capability toast dedupe.

const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: { warning: (...a: unknown[]) => toastWarning(...a) },
}))

import {
  notifyDroppedCapabilityOnce,
  __resetDroppedCapabilityToastForTesting,
} from "./dropped-capability-toast"

const translate = jest.fn((v: { model: string }) => `${v.model} ignored effort`)

beforeEach(() => {
  __resetDroppedCapabilityToastForTesting()
  toastWarning.mockClear()
  translate.mockClear()
})

describe("notifyDroppedCapabilityOnce", () => {
  const warning = {
    capability: "effort" as const,
    model: "claude-haiku-4-5",
    provider: "anthropic",
  }

  it("shows the toast with the formatted model on first call", () => {
    expect(notifyDroppedCapabilityOnce(warning, translate)).toBe(true)
    expect(translate).toHaveBeenCalledWith({ model: "claude-haiku-4-5" })
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it("dedupes repeated warnings for the same capability+model", () => {
    notifyDroppedCapabilityOnce(warning, translate)
    expect(notifyDroppedCapabilityOnce(warning, translate)).toBe(false)
    expect(toastWarning).toHaveBeenCalledTimes(1)
  })

  it("tracks distinct models independently", () => {
    notifyDroppedCapabilityOnce(warning, translate)
    expect(notifyDroppedCapabilityOnce({ ...warning, model: "claude-haiku-4-6" }, translate)).toBe(
      true
    )
    expect(toastWarning).toHaveBeenCalledTimes(2)
  })

  it("is a no-op without a warning", () => {
    expect(notifyDroppedCapabilityOnce(undefined, translate)).toBe(false)
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("swallows toast failures", () => {
    toastWarning.mockImplementationOnce(() => {
      throw new Error("no toaster mounted")
    })
    expect(notifyDroppedCapabilityOnce(warning, translate)).toBe(true)
  })
})
