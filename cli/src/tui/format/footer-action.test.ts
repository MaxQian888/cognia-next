import { footerSegmentCommand } from "./footer-action"

describe("footerSegmentCommand", () => {
  it("routes the cwd segment to /cwd", () => {
    expect(footerSegmentCommand("cwd")).toBe("/cwd")
  })

  it("routes the context gauge to /context", () => {
    expect(footerSegmentCommand("ctx")).toBe("/context")
  })

  it("routes the git branch to the /diff viewer", () => {
    expect(footerSegmentCommand("git")).toBe("/diff")
  })

  it("routes the backend segment to /backend", () => {
    expect(footerSegmentCommand("backend")).toBe("/backend")
  })

  it.each(["tokens", "cost", "cache", "ratelimit"] as const)(
    "routes the %s segment to /usage",
    (id) => {
      expect(footerSegmentCommand(id)).toBe("/usage")
    }
  )

  it.each(["model", "provider", "mode", "thinking"] as const)(
    "returns null for the inline-handled %s segment",
    (id) => {
      expect(footerSegmentCommand(id)).toBeNull()
    }
  )
})
