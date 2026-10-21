/**
 * @jest-environment jsdom
 */
const toastError = jest.fn()
jest.mock("@cognia/plugin-ui", () => ({
  toast: { error: (message: string) => toastError(message) },
}))

import { UnsafePatternError } from "../adherence/checks"
import { UnparseableAnswerError } from "../engine/llm"
import { AuditAbortedError } from "../runtime/audit"
import { RecordTooLargeError } from "../runtime/store"
import { act, errorMessage } from "./act"

const t = (key: string) => `t:${key}`

describe("act", () => {
  it("maps expected failures to their wording", () => {
    expect(errorMessage(Object.assign(new Error("x"), { code: "governance_busy" }), t)).toBe(
      "t:errors.busy"
    )
    expect(
      errorMessage(Object.assign(new Error("x"), { code: "agent_config_consent_denied" }), t)
    ).toBe("t:errors.declined")
    expect(errorMessage(new AuditAbortedError(), t)).toBe("t:errors.cancelled")
    expect(errorMessage(new UnparseableAnswerError("the judge"), t)).toBe("t:errors.unparseable")
    expect(errorMessage(new RecordTooLargeError("rules"), t)).toBe("t:errors.recordTooLarge")
    expect(errorMessage(new UnsafePatternError("(", "bad"), t)).toBe("t:errors.unsafePattern")
    // A stored status error is a plain object with the same code.
    expect(errorMessage({ message: "x", code: "governance_cancelled" }, t)).toBe(
      "t:errors.cancelled"
    )
    expect(errorMessage({ message: "kept" }, t)).toBe("kept")
    expect(errorMessage(new Error("disk"), t)).toBe("disk")
    expect(errorMessage("plain", t)).toBe("plain")
  })

  it("toasts a rejected action and ignores a resolved one", async () => {
    act(Promise.resolve(1), t)
    act(Promise.reject(new Error("boom")), t)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith("boom")
  })
})
