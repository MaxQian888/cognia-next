import { ViewContainerOpenError, isViewContainerOpenError } from "./view-container-errors"

describe("ViewContainerOpenError", () => {
  it("carries a stable name, code and the id that was refused", () => {
    const error = new ViewContainerOpenError("foreign", "other:view", "nope")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("ViewContainerOpenError")
    expect(error.code).toBe("foreign")
    expect(error.containerId).toBe("other:view")
    expect(error.message).toBe("nope")
  })
})

describe("isViewContainerOpenError", () => {
  it("recognises the host's error, optionally narrowed to one code", () => {
    const error = new ViewContainerOpenError("not-registered", "p:x", "missing")
    expect(isViewContainerOpenError(error)).toBe(true)
    expect(isViewContainerOpenError(error, "not-registered")).toBe(true)
    expect(isViewContainerOpenError(error, "foreign")).toBe(false)
  })

  it("recognises a structurally identical error from another module copy", () => {
    // A plugin bundle that inlined its own SDK, or a rejection that crossed
    // the Python boundary, is not an `instanceof` the host class.
    const copy = { name: "ViewContainerOpenError", code: "invalid-id", message: "empty" }
    expect(isViewContainerOpenError(copy)).toBe(true)
    expect(isViewContainerOpenError(copy, "invalid-id")).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isViewContainerOpenError(null)).toBe(false)
    expect(isViewContainerOpenError("ViewContainerOpenError")).toBe(false)
    expect(isViewContainerOpenError(new Error("x"))).toBe(false)
    expect(isViewContainerOpenError({ name: "ViewContainerOpenError", code: "unknown" })).toBe(
      false
    )
    expect(isViewContainerOpenError({ name: "PermissionError", code: "foreign" })).toBe(false)
  })
})
