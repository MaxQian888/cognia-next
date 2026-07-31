import { TRANSIENT_ERROR_CLASSES } from "./error-class"

describe("TRANSIENT_ERROR_CLASSES", () => {
  it("marks retryable infrastructure errors without including semantic failures", () => {
    expect(TRANSIENT_ERROR_CLASSES.has("rate-limit")).toBe(true)
    expect(TRANSIENT_ERROR_CLASSES.has("network")).toBe(true)
    expect(TRANSIENT_ERROR_CLASSES.has("server-error")).toBe(true)
    expect(TRANSIENT_ERROR_CLASSES.has("auth")).toBe(false)
    expect(TRANSIENT_ERROR_CLASSES.has("content-policy")).toBe(false)
    expect(TRANSIENT_ERROR_CLASSES.has("context-window-exceeded")).toBe(false)
  })
})
