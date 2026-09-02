import { resolveOperationAvailability } from "./operation-availability"

describe("resolveOperationAvailability", () => {
  it("is ready with no evidence against it", () => {
    expect(resolveOperationAvailability({})).toEqual({ availability: "ready" })
  })

  it("maps guard codes to auth and config", () => {
    expect(
      resolveOperationAvailability({
        guard: { allowed: false, code: "missing_credential", reason: "no key" },
      })
    ).toEqual({ availability: "needs-auth", note: "no key" })
    expect(
      resolveOperationAvailability({
        guard: { allowed: false, code: "invalid_base_url", reason: "bad url" },
      }).availability
    ).toBe("needs-config")
    expect(
      resolveOperationAvailability({
        guard: { allowed: false, code: "provider_disabled", reason: "off" },
      }).availability
    ).toBe("unavailable")
  })

  it("prefers needs-host over needs-auth when no surface is reachable", () => {
    const result = resolveOperationAvailability({
      guard: { allowed: false, code: "missing_credential" },
      descriptorSurfaces: ["sidecar"],
      hostSurfaces: ["renderer"],
    })
    expect(result.availability).toBe("needs-host")
    expect(result.note).toContain("sidecar")
  })

  it("reads the first pending checklist step", () => {
    const checklist = {
      steps: [
        { id: "credential" as const, done: true },
        { id: "base_url" as const, done: false, reason: "set a base URL" },
        { id: "verification" as const, done: false },
      ],
      total: 3,
      completed: 1,
      isComplete: false,
    }
    expect(resolveOperationAvailability({ checklist })).toEqual({
      availability: "needs-config",
      note: "set a base URL",
    })
    const verifyOnly = { ...checklist, steps: [checklist.steps[2]!], completed: 0 }
    expect(resolveOperationAvailability({ checklist: verifyOnly }).availability).toBe("ready")
  })
})
