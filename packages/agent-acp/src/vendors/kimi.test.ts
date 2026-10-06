import { kimiAcpProfile } from "./kimi"

describe("kimiAcpProfile", () => {
  const modes = kimiAcpProfile.permissionModes!

  it("keeps host-side policies for every executable mode except bypass", () => {
    expect(modes.toNative("plan")).toBe("plan")
    expect(modes.toNative("bypassPermissions")).toBe("yolo")
    expect(modes.toNative("acceptEdits")).toBe("default")
    expect(modes.toNative("dontAsk")).toBe("default")
    expect(modes.toCanonical("yolo", undefined)).toBe("bypassPermissions")
    expect(modes.toCanonical("default", "acceptEdits")).toBe("acceptEdits")
    expect(modes.toCanonical("default", "plan")).toBe("default")
  })

  it("declares the fork and compaction deviations", () => {
    expect(kimiAcpProfile.fork).toEqual({
      inheritsSourceWorkspace: true,
      requiresDistinctSessionId: true,
      rebindsMcpByReload: true,
    })
    expect(kimiAcpProfile.compactionCompletionUnavailable?.reason).toBe(
      "kimi_acp_compaction_completion_unavailable"
    )
  })
})
