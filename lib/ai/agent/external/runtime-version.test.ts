import {
  assessRuntimeVersion,
  compareSemver,
  parseProbeVersion,
  parseSemver,
  satisfiesRange,
  truncateProbeOutput,
  verdictFailsClosed,
  verdictRunsUnattended,
  MAX_RETAINED_PROBE_OUTPUT,
} from "./runtime-version"

const CHECKED_AT = "2026-08-22T10:00:00.000Z"

function sv(value: string) {
  const parsed = parseSemver(value)
  if (!parsed) throw new Error(`unparseable fixture: ${value}`)
  return parsed
}

describe("parseSemver", () => {
  it("parses release and prerelease forms", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemver("0.3.227-beta.1")).toMatchObject({
      major: 0,
      minor: 3,
      patch: 227,
      prerelease: ["beta", 1],
    })
  })

  it("tolerates surrounding whitespace and build metadata", () => {
    expect(parseSemver("  2.0.0+build.5 ")?.raw).toBe("2.0.0+build.5")
  })

  it("rejects anything that is not a strict version", () => {
    for (const bad of ["1.2", "v1.2.3", "1.2.3.4", "latest", "", "x.y.z"]) {
      expect(parseSemver(bad)).toBeUndefined()
    }
  })
})

describe("compareSemver", () => {
  it("orders by major, minor then patch", () => {
    expect(compareSemver(sv("1.0.0"), sv("2.0.0"))).toBeLessThan(0)
    expect(compareSemver(sv("1.3.0"), sv("1.2.9"))).toBeGreaterThan(0)
    expect(compareSemver(sv("1.2.3"), sv("1.2.3"))).toBe(0)
  })

  it("ranks a release above its own prereleases", () => {
    expect(compareSemver(sv("1.0.0"), sv("1.0.0-rc.1"))).toBeGreaterThan(0)
    expect(compareSemver(sv("1.0.0-rc.1"), sv("1.0.0"))).toBeLessThan(0)
  })

  it("orders prerelease identifiers numerically then lexically", () => {
    expect(compareSemver(sv("1.0.0-alpha.2"), sv("1.0.0-alpha.10"))).toBeLessThan(0)
    expect(compareSemver(sv("1.0.0-alpha"), sv("1.0.0-beta"))).toBeLessThan(0)
    // A numeric identifier has lower precedence than an alphanumeric one.
    expect(compareSemver(sv("1.0.0-1"), sv("1.0.0-alpha"))).toBeLessThan(0)
    // A longer prerelease with an identical prefix sorts higher.
    expect(compareSemver(sv("1.0.0-alpha"), sv("1.0.0-alpha.1"))).toBeLessThan(0)
  })
})

describe("satisfiesRange", () => {
  it("handles single comparators", () => {
    expect(satisfiesRange(sv("1.2.3"), ">=1.0.0")).toBe(true)
    expect(satisfiesRange(sv("0.9.0"), ">=1.0.0")).toBe(false)
    expect(satisfiesRange(sv("1.0.0"), ">1.0.0")).toBe(false)
    expect(satisfiesRange(sv("1.0.0"), "<=1.0.0")).toBe(true)
    expect(satisfiesRange(sv("1.0.0"), "=1.0.0")).toBe(true)
    expect(satisfiesRange(sv("1.0.1"), "1.0.1")).toBe(true)
  })

  it("ANDs space-separated comparators", () => {
    expect(satisfiesRange(sv("1.5.0"), ">=1.0.0 <2.0.0")).toBe(true)
    expect(satisfiesRange(sv("2.0.0"), ">=1.0.0 <2.0.0")).toBe(false)
  })

  it("ORs groups across ||", () => {
    expect(satisfiesRange(sv("3.1.0"), ">=1.0.0 <2.0.0 || >=3.0.0")).toBe(true)
    expect(satisfiesRange(sv("2.5.0"), ">=1.0.0 <2.0.0 || >=3.0.0")).toBe(false)
  })

  it("expands caret ranges including the pre-1.0 rules", () => {
    expect(satisfiesRange(sv("1.9.9"), "^1.2.0")).toBe(true)
    expect(satisfiesRange(sv("2.0.0"), "^1.2.0")).toBe(false)
    // ^0.2.3 must not admit 0.3.0 -- several agent CLIs are still pre-1.0.
    expect(satisfiesRange(sv("0.2.9"), "^0.2.3")).toBe(true)
    expect(satisfiesRange(sv("0.3.0"), "^0.2.3")).toBe(false)
    expect(satisfiesRange(sv("0.0.3"), "^0.0.3")).toBe(true)
    expect(satisfiesRange(sv("0.0.4"), "^0.0.3")).toBe(false)
  })

  it("expands tilde ranges", () => {
    expect(satisfiesRange(sv("1.2.9"), "~1.2.3")).toBe(true)
    expect(satisfiesRange(sv("1.3.0"), "~1.2.3")).toBe(false)
  })

  it("fails closed on an unreadable range", () => {
    expect(satisfiesRange(sv("1.2.3"), "not-a-range")).toBe(false)
    expect(satisfiesRange(sv("1.2.3"), "")).toBe(false)
    expect(satisfiesRange(sv("1.2.3"), ">=1.0")).toBe(false)
  })
})

describe("parseProbeVersion", () => {
  it("finds a version anywhere in the output", () => {
    expect(parseProbeVersion("semver-anywhere", "codex-cli 0.48.1 (rust)")).toBe("0.48.1")
    expect(parseProbeVersion("semver-anywhere", "1.0.0-rc.2")).toBe("1.0.0-rc.2")
  })

  it("restricts the first-line parser to the first line", () => {
    expect(parseProbeVersion("semver-first-line", "tool 1.2.3\nbundled 9.9.9")).toBe("1.2.3")
    expect(parseProbeVersion("semver-first-line", "banner\n1.2.3")).toBeUndefined()
  })

  it("requires the v prefix for the prefixed parser", () => {
    expect(parseProbeVersion("semver-prefixed-v", "release v2.3.4 built")).toBe("2.3.4")
    expect(parseProbeVersion("semver-prefixed-v", "release 2.3.4")).toBeUndefined()
  })

  it("reads a JSON version field", () => {
    expect(parseProbeVersion("json-version-field", '{"version":"5.6.7"}')).toBe("5.6.7")
    expect(parseProbeVersion("json-version-field", '{"other":"5.6.7"}')).toBeUndefined()
    expect(parseProbeVersion("json-version-field", "not json")).toBeUndefined()
  })

  it("returns undefined for empty output rather than guessing", () => {
    expect(parseProbeVersion("semver-anywhere", "   ")).toBeUndefined()
  })
})

describe("truncateProbeOutput", () => {
  it("keeps short output verbatim", () => {
    expect(truncateProbeOutput("  hi  ")).toBe("hi")
  })

  it("caps long output", () => {
    const result = truncateProbeOutput("x".repeat(MAX_RETAINED_PROBE_OUTPUT + 50))
    expect(result).toHaveLength(MAX_RETAINED_PROBE_OUTPUT + 1)
    expect(result.endsWith("…")).toBe(true)
  })
})

describe("assessRuntimeVersion", () => {
  const observation = { parser: "semver-anywhere" as const, checkedAt: CHECKED_AT }

  it("reports a missing runtime when the probe produced nothing at all", () => {
    const result = assessRuntimeVersion({ runtimeId: "codex-acp" }, { ...observation })
    expect(result.verdict).toBe("missing")
    expect(result.blockingCode).toBe("runtime_missing")
    expect(result.detectedVersion).toBeUndefined()
  })

  it("certifies an exact listed version", () => {
    const result = assessRuntimeVersion(
      { runtimeId: "codex-acp", supportedRange: ">=1.0.0", certifiedVersions: ["1.2.3"] },
      { ...observation, output: "codex-acp 1.2.3" }
    )
    expect(result.verdict).toBe("certified")
    expect(result.detectedVersion).toBe("1.2.3")
    expect(result.blockingCode).toBeUndefined()
    expect(verdictRunsUnattended(result.verdict)).toBe(true)
  })

  it("treats a supported but unlisted version as needing consent", () => {
    const result = assessRuntimeVersion(
      { runtimeId: "codex-acp", supportedRange: ">=1.0.0", certifiedVersions: ["1.2.3"] },
      { ...observation, output: "codex-acp 1.4.0" }
    )
    expect(result.verdict).toBe("supported-uncertified")
    expect(result.blockingCode).toBe("version_uncertified")
    expect(verdictFailsClosed(result.verdict)).toBe(false)
  })

  it("refuses a version outside the supported range", () => {
    const result = assessRuntimeVersion(
      { runtimeId: "codex-acp", supportedRange: ">=1.0.0", certifiedVersions: ["1.2.3"] },
      { ...observation, output: "codex-acp 0.9.0" }
    )
    expect(result.verdict).toBe("unsupported")
    expect(result.blockingCode).toBe("version_unsupported")
    expect(verdictFailsClosed(result.verdict)).toBe(true)
  })

  it("refuses output it cannot read, and keeps the evidence", () => {
    const result = assessRuntimeVersion(
      { runtimeId: "codex-acp", supportedRange: ">=1.0.0" },
      { ...observation, output: "unknown command" }
    )
    expect(result.verdict).toBe("unparseable")
    expect(result.blockingCode).toBe("version_unsupported")
    expect(result.rawOutput).toBe("unknown command")
    expect(verdictFailsClosed(result.verdict)).toBe(true)
  })

  it("treats a runtime with no declared range as uncertified, never as unconstrained", () => {
    // This is the load-bearing asymmetry: missing certification data must not
    // resolve to a silent pass, which is what the pre-catalog presets did.
    const result = assessRuntimeVersion(
      { runtimeId: "droid" },
      { ...observation, output: "droid 7.7.7" }
    )
    expect(result.verdict).toBe("supported-uncertified")
    expect(result.blockingCode).toBe("version_uncertified")
  })

  it("carries executable identity through so consent can be bound to it", () => {
    const result = assessRuntimeVersion(
      { runtimeId: "droid" },
      {
        ...observation,
        output: "droid 7.7.7",
        executablePath: "/usr/local/bin/droid",
        executableDigest: "a".repeat(64),
      }
    )
    expect(result.executablePath).toBe("/usr/local/bin/droid")
    expect(result.executableDigest).toBe("a".repeat(64))
    expect(result.checkedAt).toBe(CHECKED_AT)
  })
})
