import {
  DSH_ACP_CAPABILITIES,
  DSH_PLATFORMS,
  DSH_PROFILE_IDS,
  DSH_SDK_CAPABILITIES,
  DSH_TRANSPORTS,
  dshCapabilitiesForTransport,
  dshCapabilitySnapshotSchema,
  dshRuntimeChannelSchema,
  isReadOnlyProfile,
  profileTransport,
  type DshRuntimeChannel,
} from "./dsh-runtime-channel"

const DIGEST_A = "a".repeat(64)
const DIGEST_B = "b".repeat(64)

function validChannel(): DshRuntimeChannel {
  return {
    schemaVersion: 1,
    channelId: "dsh-0.1.0-rc.6-aaaaaaaa",
    lockfileDigest: DIGEST_A,
    compositionDigest: DIGEST_B,
    upstreamVersion: "0.1.0-rc.6",
    nodeMajorRequired: 26,
    platforms: ["darwin-arm64"],
    profiles: [
      {
        profileId: "cognia-sdk-readonly",
        compositionFile: "host.sdk-readonly.yml",
        capabilities: DSH_SDK_CAPABILITIES,
        requiresNativeSubprocess: false,
      },
    ],
    conformanceSuiteVersion: "1",
    experimental: true,
  }
}

describe("DSH capability facts", () => {
  // These constants are the anti-drift mechanism for upstream's documented
  // limitations. If a future RC changes one, the change must be deliberate.

  it("grants the SDK transport full observability", () => {
    expect(DSH_SDK_CAPABILITIES).toMatchObject({
      streamingDeltas: true,
      toolEvents: true,
      reasoning: true,
      usage: true,
      subagentLineage: true,
    })
  })

  it("denies the SDK transport approval and turn cancellation", () => {
    // Upstream: server->client requests are a dead capability, and the wire has
    // no prompt-cancel method.
    expect(DSH_SDK_CAPABILITIES.interactiveApproval).toBe(false)
    expect(DSH_SDK_CAPABILITIES.turnCancellation).toBe(false)
  })

  it("denies the ACP transport every observability capability", () => {
    // "Committed answers only -- live progress, reasoning, tool activity,
    // plans, titles, and usage stay off the wire."
    expect(DSH_ACP_CAPABILITIES).toMatchObject({
      streamingDeltas: false,
      toolEvents: false,
      reasoning: false,
      usage: false,
      subagentLineage: false,
    })
  })

  it("grants the ACP transport approval and turn cancellation", () => {
    expect(DSH_ACP_CAPABILITIES.interactiveApproval).toBe(true)
    expect(DSH_ACP_CAPABILITIES.turnCancellation).toBe(true)
  })

  it("denies MCP passthrough on ACP but allows it on SDK", () => {
    // session/new rejects a non-empty mcpServers.
    expect(DSH_ACP_CAPABILITIES.mcpPassthrough).toBe(false)
    expect(DSH_SDK_CAPABILITIES.mcpPassthrough).toBe(true)
  })

  it("denies session resume on both transports", () => {
    expect(DSH_SDK_CAPABILITIES.sessionResume).toBe(false)
    expect(DSH_ACP_CAPABILITIES.sessionResume).toBe(false)
  })

  it("makes the two transports differ on exactly the observability/control split", () => {
    // The whole reason SDK is the default channel: it is strictly better at
    // being watched, strictly worse at being interrupted.
    const observability = [
      "streamingDeltas",
      "toolEvents",
      "reasoning",
      "usage",
      "subagentLineage",
    ] as const
    for (const key of observability) {
      expect(DSH_SDK_CAPABILITIES[key]).toBe(true)
      expect(DSH_ACP_CAPABILITIES[key]).toBe(false)
    }
    const control = ["interactiveApproval", "turnCancellation"] as const
    for (const key of control) {
      expect(DSH_SDK_CAPABILITIES[key]).toBe(false)
      expect(DSH_ACP_CAPABILITIES[key]).toBe(true)
    }
  })

  it("validates both snapshots against the schema", () => {
    expect(dshCapabilitySnapshotSchema.safeParse(DSH_SDK_CAPABILITIES).success).toBe(true)
    expect(dshCapabilitySnapshotSchema.safeParse(DSH_ACP_CAPABILITIES).success).toBe(true)
  })

  it("resolves capabilities by transport", () => {
    expect(dshCapabilitiesForTransport("dsh-sdk")).toBe(DSH_SDK_CAPABILITIES)
    expect(dshCapabilitiesForTransport("acp")).toBe(DSH_ACP_CAPABILITIES)
  })

  it("covers every declared transport", () => {
    for (const transport of DSH_TRANSPORTS) {
      expect(dshCapabilitiesForTransport(transport).transport).toBe(transport)
    }
  })
})

describe("profile classification", () => {
  it("treats only the read-only SDK profile as read-only", () => {
    // Not derivable from sandbox mode: cognia-sdk-workspace also has a sandbox,
    // and the read-only guarantee rests on no approval provider being composed.
    expect(isReadOnlyProfile("cognia-sdk-readonly")).toBe(true)
    expect(isReadOnlyProfile("cognia-sdk-workspace")).toBe(false)
    expect(isReadOnlyProfile("cognia-acp")).toBe(false)
  })

  it("maps each profile to its transport", () => {
    expect(profileTransport("cognia-sdk-readonly")).toBe("dsh-sdk")
    expect(profileTransport("cognia-sdk-workspace")).toBe("dsh-sdk")
    expect(profileTransport("cognia-acp")).toBe("acp")
  })

  it("classifies every declared profile", () => {
    for (const profileId of DSH_PROFILE_IDS) {
      expect(DSH_TRANSPORTS).toContain(profileTransport(profileId))
    }
  })
})

describe("dshRuntimeChannelSchema", () => {
  it("accepts a well-formed channel", () => {
    expect(dshRuntimeChannelSchema.safeParse(validChannel()).success).toBe(true)
  })

  it("rejects a non-sha256 lockfile digest", () => {
    // Identity is the digest; a truncated or differently-encoded one would make
    // two different dependency trees compare equal.
    const channel = { ...validChannel(), lockfileDigest: "abc123" }
    expect(dshRuntimeChannelSchema.safeParse(channel).success).toBe(false)
  })

  it("rejects an uppercase digest", () => {
    const channel = { ...validChannel(), lockfileDigest: DIGEST_A.toUpperCase() }
    expect(dshRuntimeChannelSchema.safeParse(channel).success).toBe(false)
  })

  it("rejects a Node major upstream does not support", () => {
    const channel = { ...validChannel(), nodeMajorRequired: 20 as unknown as 22 }
    expect(dshRuntimeChannelSchema.safeParse(channel).success).toBe(false)
  })

  it("rejects a channel claiming to be non-experimental", () => {
    // Upstream is a developer preview promising breaking changes; nothing built
    // on it may advertise itself as stable.
    const channel = { ...validChannel(), experimental: false as unknown as true }
    expect(dshRuntimeChannelSchema.safeParse(channel).success).toBe(false)
  })

  it("rejects a channel with no profiles or no platforms", () => {
    expect(dshRuntimeChannelSchema.safeParse({ ...validChannel(), profiles: [] }).success).toBe(
      false
    )
    expect(dshRuntimeChannelSchema.safeParse({ ...validChannel(), platforms: [] }).success).toBe(
      false
    )
  })

  it("rejects an unknown profile id", () => {
    const channel = validChannel()
    const profiles = [{ ...channel.profiles[0], profileId: "cognia-sdk-danger" as never }]
    expect(dshRuntimeChannelSchema.safeParse({ ...channel, profiles }).success).toBe(false)
  })

  it("rejects an unknown platform", () => {
    const channel = { ...validChannel(), platforms: ["win32-x64" as never] }
    // Windows is out of scope for the first phase: koffi would need building.
    expect(dshRuntimeChannelSchema.safeParse(channel).success).toBe(false)
  })

  it("declares only platforms with usable native support", () => {
    expect([...DSH_PLATFORMS]).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"])
  })
})
