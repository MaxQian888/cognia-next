import { BRAIN_PROFILE_ENV, resolveBrainProfile } from "./brain-profile"

describe("resolveBrainProfile", () => {
  it("boots the Host brain when no profile is set", () => {
    expect(resolveBrainProfile({ NODE_ENV: "test" })).toEqual({ ok: true, host: "brain" })
    expect(resolveBrainProfile({ NODE_ENV: "test", [BRAIN_PROFILE_ENV]: "" })).toEqual({
      ok: true,
      host: "brain",
    })
  })

  it("boots a member's data partition for the person profile", () => {
    expect(resolveBrainProfile({ NODE_ENV: "test", [BRAIN_PROFILE_ENV]: "person" })).toEqual({
      ok: true,
      host: "person-brain",
    })
  })

  it("refuses any other value instead of falling back to a full brain", () => {
    for (const value of ["Person", "brain", "operator", " person"]) {
      const profile = resolveBrainProfile({ NODE_ENV: "test", [BRAIN_PROFILE_ENV]: value })
      expect(profile.ok).toBe(false)
    }
  })
})
