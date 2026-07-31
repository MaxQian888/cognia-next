import { summarizeTwinProfile } from "./profile-summary"
import type { TwinProfile } from "@/types/twin"

function makeProfile(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    id: "default",
    twinId: "default",
    styleSamples: [],
    playbooks: [],
    entities: [],
    decisions: [],
    voiceSummary: "",
    updatedAt: 1000,
    ...overrides,
  }
}

describe("summarizeTwinProfile", () => {
  it("returns null for null/undefined", () => {
    expect(summarizeTwinProfile(null)).toBeNull()
    expect(summarizeTwinProfile(undefined)).toBeNull()
  })

  it("counts style samples and entities from the raw row", () => {
    const profile = makeProfile({
      styleSamples: [
        { id: "s1", summary: "a", sourceChunkId: "c1" },
        { id: "s2", summary: "b", sourceChunkId: "c2" },
      ] as TwinProfile["styleSamples"],
      entities: [{ name: "Ada", role: "person" }] as TwinProfile["entities"],
      voiceSummary: "Direct and concise.",
      updatedAt: 4242,
    })
    const summary = summarizeTwinProfile(profile)
    expect(summary).toEqual({
      twinId: "default",
      updatedAt: 4242,
      sampleCount: 2,
      entityCount: 1,
      styleSummary: "Direct and concise.",
    })
  })

  it("omits styleSummary when voiceSummary is blank", () => {
    expect(summarizeTwinProfile(makeProfile({ voiceSummary: "   " }))?.styleSummary).toBeUndefined()
    expect(summarizeTwinProfile(makeProfile({ voiceSummary: "" }))?.styleSummary).toBeUndefined()
  })

  it("returns null for non-profile junk from an untyped RPC (array / partial object)", () => {
    expect(summarizeTwinProfile([] as never)).toBeNull()
    // A partial object with missing arrays still summarizes safely to zeros.
    const partial = summarizeTwinProfile({ twinId: "x" } as never)
    expect(partial).toEqual({
      twinId: "x",
      updatedAt: undefined,
      sampleCount: 0,
      entityCount: 0,
      styleSummary: undefined,
    })
  })
})
