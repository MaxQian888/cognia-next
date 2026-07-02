import { classifyError } from "./error-classify"

describe("classifyError", () => {
  it("classifies the sidecar-exit code regardless of message", () => {
    const c = classifyError({ message: "anything at all", code: "sidecar_exited" })
    expect(c.category).toBe("sidecar")
    expect(c.title).toBe("Backend stopped")
    expect(c.hint).toMatch(/restarts automatically/i)
  })

  it("buckets 401 / unauthorized as auth", () => {
    expect(classifyError({ message: "Request failed: 401 Unauthorized" }).category).toBe("auth")
    expect(classifyError({ message: "invalid api key" }).category).toBe("auth")
    expect(classifyError({ message: "authentication error" }).hint).toMatch(/re-authenticate/i)
  })

  it("buckets 429 / quota / overloaded as rateLimit", () => {
    expect(classifyError({ message: "429 Too Many Requests" }).category).toBe("rateLimit")
    expect(classifyError({ message: "quota exceeded" }).category).toBe("rateLimit")
    expect(classifyError({ message: "Overloaded" }).category).toBe("rateLimit")
    expect(classifyError({ message: "rate-limit hit" }).title).toBe("Rate limited")
  })

  it("buckets timeout wording as timeout (before the network catch)", () => {
    expect(classifyError({ message: "Stream timed out" }).category).toBe("timeout")
    expect(classifyError({ message: "ETIMEDOUT" }).category).toBe("timeout")
    expect(classifyError({ message: "idle timeout exceeded" }).hint).toMatch(/streamIdleTimeoutMs/)
  })

  it("buckets connection / dns faults as network", () => {
    expect(classifyError({ message: "connect ECONNREFUSED 127.0.0.1:443" }).category).toBe(
      "network"
    )
    expect(classifyError({ message: "getaddrinfo ENOTFOUND api.example.com" }).category).toBe(
      "network"
    )
    expect(classifyError({ message: "fetch failed" }).category).toBe("network")
  })

  it("buckets a permission-denied message as permission", () => {
    expect(classifyError({ message: "Permission denied: Bash" }).category).toBe("permission")
  })

  it("falls back to generic with no hint for an unknown error", () => {
    const c = classifyError({ message: "some unexpected failure" })
    expect(c.category).toBe("generic")
    expect(c.title).toBe("Error")
    expect(c.hint).toBeUndefined()
  })

  it("tolerates an empty message", () => {
    expect(classifyError({ message: "" }).category).toBe("generic")
  })

  it("tolerates a missing message (undefined)", () => {
    expect(classifyError({ message: undefined as unknown as string }).category).toBe("generic")
  })
})
