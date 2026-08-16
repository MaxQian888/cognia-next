import {
  DSH_ACP_CAPABILITIES,
  DSH_SDK_CAPABILITIES,
  dshRuntimeChannelSchema,
  type DshRuntimeChannel,
} from "@/types/agent/dsh-runtime-channel"

import {
  DshLaunchConfigurationError,
  buildDshChannelManifest,
  buildDshLaunchSpec,
  dshRuntimeCapabilities,
  doctorDshRuntime,
  dshPlatformKey,
  findProfile,
  isPathInside,
  isSupportedDshPlatform,
  isUnattendedSafeProfile,
  parseNodeMajor,
  redactDshOutput,
  type DshInstalledRuntimeFacts,
  type DshLaunchOptions,
} from "./dsh-runtime-install"

const LOCK_DIGEST = "1".repeat(64)
const COMP_DIGEST = "2".repeat(64)

function channel(overrides: Partial<DshRuntimeChannel> = {}): DshRuntimeChannel {
  return {
    schemaVersion: 1,
    channelId: "dsh-0.1.0-rc.6",
    lockfileDigest: LOCK_DIGEST,
    compositionDigest: COMP_DIGEST,
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
      {
        profileId: "cognia-sdk-workspace",
        compositionFile: "host.sdk-workspace.yml",
        capabilities: DSH_SDK_CAPABILITIES,
        requiresNativeSubprocess: true,
      },
    ],
    conformanceSuiteVersion: "1",
    experimental: true,
    ...overrides,
  }
}

function facts(overrides: Partial<DshInstalledRuntimeFacts> = {}): DshInstalledRuntimeFacts {
  return {
    lockfileDigest: LOCK_DIGEST,
    compositionDigest: COMP_DIGEST,
    nodeVersion: "v26.3.1",
    platform: "darwin-arm64",
    ...overrides,
  }
}

describe("parseNodeMajor", () => {
  it.each([
    ["v26.3.1", 26],
    ["26.3.1", 26],
    ["v22.19.0", 22],
  ])("parses %s", (input, expected) => {
    expect(parseNodeMajor(input)).toBe(expected)
  })

  it.each(["", "not-a-version", "v"])("returns undefined for %s", (input) => {
    expect(parseNodeMajor(input)).toBeUndefined()
  })
})

describe("platform helpers", () => {
  it("recognizes supported platforms", () => {
    expect(isSupportedDshPlatform("darwin-arm64")).toBe(true)
    expect(isSupportedDshPlatform("win32-x64")).toBe(false)
  })

  it("builds a platform key matching upstream prebuild spellings", () => {
    expect(dshPlatformKey("darwin", "arm64")).toBe("darwin-arm64")
  })
})

describe("doctorDshRuntime", () => {
  it("reports healthy for a matching install", () => {
    const report = doctorDshRuntime(channel(), facts(), "cognia-sdk-readonly")
    expect(report).toEqual({ healthy: true, findings: [] })
  })

  it("fails a malformed channel without evaluating anything else", () => {
    const report = doctorDshRuntime({ schemaVersion: 2 }, facts(), "cognia-sdk-readonly")
    expect(report.healthy).toBe(false)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].code).toBe("channel-malformed")
  })

  it("detects a lockfile digest mismatch", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ lockfileDigest: "9".repeat(64) }),
      "cognia-sdk-readonly"
    )
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("lockfile-digest-mismatch")
  })

  it("detects a composition digest mismatch", () => {
    // The composition carries the sandbox and approval wiring, so a drifting
    // digest means the certified authority is no longer what is on disk.
    const report = doctorDshRuntime(
      channel(),
      facts({ compositionDigest: "9".repeat(64) }),
      "cognia-sdk-readonly"
    )
    expect(report.findings.map((f) => f.code)).toContain("composition-digest-mismatch")
  })

  it("rejects a Node older than the channel requires", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ nodeVersion: "v20.11.0" }),
      "cognia-sdk-readonly"
    )
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("node-version-unsupported")
  })

  it("accepts a Node newer than required", () => {
    expect(
      doctorDshRuntime(channel(), facts({ nodeVersion: "v28.0.0" }), "cognia-sdk-readonly").healthy
    ).toBe(true)
  })

  it("rejects an unparsable Node version rather than assuming it is fine", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ nodeVersion: "unknown" }),
      "cognia-sdk-readonly"
    )
    expect(report.findings.map((f) => f.code)).toContain("node-version-unsupported")
  })

  it("rejects a platform the channel was not certified for", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ platform: "linux-x64" }),
      "cognia-sdk-readonly"
    )
    expect(report.findings.map((f) => f.code)).toContain("platform-unsupported")
  })

  it("treats a stray patch layer as fatal on the read-only profile", () => {
    // Such a file can insert plugin rows and run arbitrary JS via !!js, after
    // the digests have already verified.
    const report = doctorDshRuntime(
      channel(),
      facts({ strayPatchPaths: ["/rt/home/cordis.patch.yml"] }),
      "cognia-sdk-readonly"
    )
    expect(report.healthy).toBe(false)
    const finding = report.findings.find((f) => f.code === "stray-patch-layer")
    expect(finding?.severity).toBe("error")
    expect(finding?.detail).toBe("/rt/home/cordis.patch.yml")
  })

  it("downgrades a stray patch layer to a warning on a write-capable profile", () => {
    // That profile already grants write authority, so the layer crosses no
    // boundary it was defending.
    const report = doctorDshRuntime(
      channel(),
      facts({ strayPatchPaths: ["/rt/home/cordis.patch.yml"], hasNativeToolchain: true }),
      "cognia-sdk-workspace"
    )
    expect(report.healthy).toBe(true)
    expect(report.findings.find((f) => f.code === "stray-patch-layer")?.severity).toBe("warning")
  })

  it("reports every stray patch layer, not just the first", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ strayPatchPaths: ["/a/cordis.patch.yml", "/b/profiles/x/cordis.patch.yml"] }),
      "cognia-sdk-readonly"
    )
    expect(report.findings.filter((f) => f.code === "stray-patch-layer")).toHaveLength(2)
  })

  it("requires a toolchain only for profiles that compose a subprocess provider", () => {
    // node-pty has no Linux prebuild upstream.
    const withoutToolchain = facts({ hasNativeToolchain: false })
    expect(
      doctorDshRuntime(channel(), withoutToolchain, "cognia-sdk-workspace").findings.map(
        (f) => f.code
      )
    ).toContain("native-toolchain-missing")
    expect(
      doctorDshRuntime(channel(), withoutToolchain, "cognia-sdk-readonly").findings.map(
        (f) => f.code
      )
    ).not.toContain("native-toolchain-missing")
  })

  it("does not demand a toolchain when the caller did not probe for one", () => {
    const report = doctorDshRuntime(channel(), facts(), "cognia-sdk-workspace")
    expect(report.findings.map((f) => f.code)).not.toContain("native-toolchain-missing")
  })

  it("accumulates independent failures", () => {
    const report = doctorDshRuntime(
      channel(),
      facts({ lockfileDigest: "9".repeat(64), nodeVersion: "v20.0.0", platform: "linux-arm64" }),
      "cognia-sdk-readonly"
    )
    expect(report.findings.map((f) => f.code).sort()).toEqual([
      "lockfile-digest-mismatch",
      "node-version-unsupported",
      "platform-unsupported",
    ])
  })
})

describe("findProfile", () => {
  it("finds a declared profile and misses an undeclared one", () => {
    expect(findProfile(channel(), "cognia-sdk-readonly")?.compositionFile).toBe(
      "host.sdk-readonly.yml"
    )
    expect(findProfile(channel(), "cognia-acp")).toBeUndefined()
  })
})

describe("isPathInside", () => {
  it.each([
    ["/rt", "/rt", true],
    ["/rt/home", "/rt", true],
    ["/rt-evil", "/rt", false],
    ["/other", "/rt", false],
    ["/rt/home", "/rt/", true],
  ])("isPathInside(%s, %s) === %s", (child, parent, expected) => {
    expect(isPathInside(child, parent)).toBe(expected)
  })

  it("handles Windows-style paths", () => {
    expect(isPathInside("C:\\rt\\home", "C:\\rt")).toBe(true)
    expect(isPathInside("C:\\rt-evil", "C:\\rt")).toBe(false)
  })
})

describe("buildDshLaunchSpec", () => {
  function options(overrides: Partial<DshLaunchOptions> = {}): DshLaunchOptions {
    return {
      paths: {
        runtimeHome: "/rt",
        launcherPath: "/rt/launcher.mjs",
        compositionPath: "/rt/host.sdk-readonly.yml",
        dshHome: "/rt/home",
        workspace: "/work",
        sessionRoot: "/rt/sessions",
      },
      apiKey: "sk-test-key-1234567890",
      parentEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
        AWS_SECRET_ACCESS_KEY: "should-not-leak",
      },
      nodePath: "/bundled/node",
      ...overrides,
    }
  }

  it("builds the documented command shape", () => {
    const spec = buildDshLaunchSpec(options())
    expect(spec.command).toBe("/bundled/node")
    expect(spec.args).toEqual(["/rt/launcher.mjs", "/rt/host.sdk-readonly.yml"])
  })

  it("passes only allowlisted variables from the parent environment", () => {
    // HarnessClientOptions.env replaces the child environment wholesale, so an
    // unrelated provider key in the parent must not reach a DSH tool process.
    const spec = buildDshLaunchSpec(options())
    expect(spec.env.PATH).toBe("/usr/bin")
    expect(spec.env.LANG).toBe("en_US.UTF-8")
    expect(spec.env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(spec.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
  })

  it("pins HOME and DSH_HOME into the runtime home", () => {
    // HOME is redirected too, so DSH's own ~/.dsh fallback still lands in
    // Cognia-owned space if DSH_HOME were ever dropped.
    const spec = buildDshLaunchSpec(options())
    expect(spec.env.HOME).toBe("/rt")
    expect(spec.env.DSH_HOME).toBe("/rt/home")
    expect(spec.env.COGNIA_DSH_RUNTIME_HOME).toBe("/rt")
  })

  it("injects the API key", () => {
    expect(buildDshLaunchSpec(options()).env.DEEPSEEK_API_KEY).toBe("sk-test-key-1234567890")
  })

  it("refuses to launch without a resolved key", () => {
    // Launching keyless would fail deep inside the model route with a confusing
    // error; refusing here keeps the failure attributable.
    expect(() => buildDshLaunchSpec(options({ apiKey: "" }))).toThrow(DshLaunchConfigurationError)
  })

  it("refuses a DSH_HOME outside the runtime home", () => {
    const bad = options()
    bad.paths = { ...bad.paths, dshHome: "/home/user/.dsh" }
    expect(() => buildDshLaunchSpec(bad)).toThrow(DshLaunchConfigurationError)
  })

  it("refuses a sibling-prefix DSH_HOME", () => {
    const bad = options()
    bad.paths = { ...bad.paths, dshHome: "/rt-evil" }
    expect(() => buildDshLaunchSpec(bad)).toThrow(DshLaunchConfigurationError)
  })

  it("omits optional tuning when not supplied", () => {
    const spec = buildDshLaunchSpec(options())
    expect(spec.env).not.toHaveProperty("COGNIA_DSH_MODEL")
    expect(spec.env).not.toHaveProperty("COGNIA_DSH_CONTEXT_WINDOW")
    expect(spec.env).not.toHaveProperty("COGNIA_DSH_PERSONA")
  })

  it("passes optional tuning when supplied", () => {
    const spec = buildDshLaunchSpec(
      options({ model: "deepseek-v4-pro", contextWindow: 128000, persona: "Be terse." })
    )
    expect(spec.env.COGNIA_DSH_MODEL).toBe("deepseek-v4-pro")
    expect(spec.env.COGNIA_DSH_CONTEXT_WINDOW).toBe("128000")
    expect(spec.env.COGNIA_DSH_PERSONA).toBe("Be terse.")
  })

  it("skips allowlisted variables that are absent or empty", () => {
    const spec = buildDshLaunchSpec(options({ parentEnv: { PATH: "/usr/bin", LANG: "" } }))
    expect(spec.env).not.toHaveProperty("LANG")
    expect(spec.env).not.toHaveProperty("TZ")
  })
})

describe("redactDshOutput", () => {
  it("removes a known secret", () => {
    expect(redactDshOutput("key=sk-abcdefghijklmnop done", ["sk-abcdefghijklmnop"])).toBe(
      "key=[redacted] done"
    )
  })

  it("removes every occurrence", () => {
    expect(redactDshOutput("a SECRETVALUE b SECRETVALUE", ["SECRETVALUE"])).toBe(
      "a [redacted] b [redacted]"
    )
  })

  it("catches a DeepSeek-shaped key the caller did not pass in", () => {
    // Transport loss surfaces a bounded stderr tail; a key can arrive through a
    // path the caller never knew about.
    expect(redactDshOutput("leaked sk-0123456789abcdef0123 here", [])).toBe(
      "leaked [redacted] here"
    )
  })

  it("ignores short values that would over-match", () => {
    expect(redactDshOutput("the cat sat", ["cat"])).toBe("the cat sat")
  })

  it("ignores empty secrets", () => {
    expect(redactDshOutput("unchanged", ["", "  "])).toBe("unchanged")
  })
})

describe("isUnattendedSafeProfile", () => {
  it("permits only the read-only SDK profile", () => {
    expect(isUnattendedSafeProfile("cognia-sdk-readonly")).toBe(true)
    expect(isUnattendedSafeProfile("cognia-sdk-workspace")).toBe(false)
    // ACP can ask for approval, but that means it needs someone to ask.
    expect(isUnattendedSafeProfile("cognia-acp")).toBe(false)
  })
})

describe("buildDshChannelManifest", () => {
  const DIGESTS = { lockfileDigest: "3".repeat(64), compositionDigest: "4".repeat(64) }

  it("produces a schema-valid channel", () => {
    expect(dshRuntimeChannelSchema.safeParse(buildDshChannelManifest(DIGESTS)).success).toBe(true)
  })

  it("derives the channel id from the composition digest, not the version", () => {
    // Upstream shipped six release candidates in three days, so the version
    // string carries no identity.
    const manifest = buildDshChannelManifest(DIGESTS)
    expect(manifest.channelId).toContain(DIGESTS.compositionDigest.slice(0, 8))
  })

  it("always marks the channel experimental", () => {
    expect(buildDshChannelManifest(DIGESTS).experimental).toBe(true)
  })

  it("declares all three profiles", () => {
    const ids = buildDshChannelManifest(DIGESTS).profiles.map((p) => p.profileId)
    expect(ids.sort()).toEqual(["cognia-acp", "cognia-sdk-readonly", "cognia-sdk-workspace"])
  })

  it("gives the ACP profile ACP capabilities, not SDK ones", () => {
    // The two transports differ on exactly the observability/control split; a
    // profile advertising the wrong set would render controls that do nothing.
    const acp = buildDshChannelManifest(DIGESTS).profiles.find((p) => p.profileId === "cognia-acp")!
    expect(acp.capabilities.transport).toBe("acp")
    expect(acp.capabilities.interactiveApproval).toBe(true)
    expect(acp.capabilities.turnCancellation).toBe(true)
    expect(acp.capabilities.toolEvents).toBe(false)
  })

  it("marks only the workspace profile as needing a native toolchain", () => {
    // node-pty has no Linux prebuild upstream; ACP and read-only compose no
    // subprocess provider at all.
    const byId = Object.fromEntries(
      buildDshChannelManifest(DIGESTS).profiles.map((p) => [p.profileId, p])
    )
    expect(byId["cognia-sdk-workspace"].requiresNativeSubprocess).toBe(true)
    expect(byId["cognia-sdk-readonly"].requiresNativeSubprocess).toBe(false)
    expect(byId["cognia-acp"].requiresNativeSubprocess).toBe(false)
  })

  it("maps each profile to its own composition file", () => {
    const files = buildDshChannelManifest(DIGESTS).profiles.map((p) => p.compositionFile)
    expect(new Set(files).size).toBe(files.length)
    expect(files).toContain("host.acp.yml")
  })
})

describe("dshRuntimeCapabilities", () => {
  it("grants streaming to the SDK transport but not ACP", () => {
    // ACP is committed-answers-only, so a streaming capability would be a lie.
    expect(dshRuntimeCapabilities(DSH_SDK_CAPABILITIES)).toContain("streaming")
    expect(dshRuntimeCapabilities(DSH_ACP_CAPABILITIES)).not.toContain("streaming")
  })

  it("grants permission mode-setting only where the wire can carry the question", () => {
    expect(dshRuntimeCapabilities(DSH_ACP_CAPABILITIES)).toContain("permissions.set-mode")
    expect(dshRuntimeCapabilities(DSH_SDK_CAPABILITIES)).not.toContain("permissions.set-mode")
  })

  it("never grants session.resume, which neither transport supports", () => {
    // The static `RUNTIME_CAPABILITIES.external` table does grant it, which is
    // exactly why this intersection exists.
    for (const snapshot of [DSH_SDK_CAPABILITIES, DSH_ACP_CAPABILITIES]) {
      expect(dshRuntimeCapabilities(snapshot)).not.toContain("session.resume")
    }
  })

  it("always grants the ordinary tool surface", () => {
    for (const snapshot of [DSH_SDK_CAPABILITIES, DSH_ACP_CAPABILITIES]) {
      expect(dshRuntimeCapabilities(snapshot)).toEqual(
        expect.arrayContaining(["tools.ordinary", "tools.results", "tools.errors"])
      )
    }
  })
})
