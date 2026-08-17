import { artifactSupportFor, type ArtifactSupport } from "./providers"
import { MIGRATION_ARTIFACTS, MIGRATION_VENDORS, type MigrationVendor } from "./types"

describe("artifactSupportFor", () => {
  it("marks Claude commands and all vendor memory as shared", () => {
    expect(artifactSupportFor("claude-code", "commands")).toBe("shared")
    expect(artifactSupportFor("codex", "memory")).toBe("shared")
    expect(artifactSupportFor("opencode", "memory")).toBe("shared")
  })

  it("supports every other requested vendor/artifact pair", () => {
    expect(artifactSupportFor("opencode", "skills")).toBe("supported")
    expect(artifactSupportFor("codex", "settings")).toBe("supported")
  })

  /**
   * The whole matrix, pinned. This exists because the function used to end in
   * `return "supported"`: any vendor added to MIGRATION_VENDORS immediately
   * claimed all seven artifacts worked, with no adapter behind them. If a new
   * vendor lands, this test fails until its real support is declared — which
   * is the intended cost of adding one.
   */
  it("declares an explicit answer for every vendor and artifact", () => {
    const declared: Record<string, Record<string, ArtifactSupport>> = {}
    for (const vendor of MIGRATION_VENDORS) {
      declared[vendor] = {}
      for (const artifact of MIGRATION_ARTIFACTS) {
        declared[vendor][artifact] = artifactSupportFor(vendor, artifact)
      }
    }
    expect(declared).toEqual({
      "claude-code": {
        settings: "supported",
        sessions: "supported",
        skills: "supported",
        subagents: "supported",
        mcp: "supported",
        commands: "shared",
        memory: "shared",
      },
      codex: {
        settings: "supported",
        sessions: "supported",
        skills: "supported",
        subagents: "supported",
        mcp: "supported",
        commands: "supported",
        memory: "shared",
      },
      opencode: {
        settings: "supported",
        sessions: "supported",
        skills: "supported",
        subagents: "supported",
        mcp: "supported",
        commands: "supported",
        memory: "shared",
      },
      pi: {
        settings: "supported",
        sessions: "supported",
        skills: "supported",
        subagents: "supported",
        // Pi's core ships no MCP support at all — it arrives only via the
        // third-party pi-mcp-adapter package.
        mcp: "unsupported",
        commands: "supported",
        memory: "shared",
      },
    })
  })

  it("does not offer Pi an MCP import a stock Pi install cannot satisfy", () => {
    expect(artifactSupportFor("pi", "mcp")).toBe("unsupported")
  })

  /** Fail closed: an unrecognised pair must never be reported as importable. */
  it("returns unsupported for a vendor with no declared row", () => {
    expect(artifactSupportFor("not-a-vendor" as MigrationVendor, "settings")).toBe("unsupported")
  })

  it("returns unsupported for an artifact missing from a declared row", () => {
    expect(artifactSupportFor("codex", "not-an-artifact" as never)).toBe("unsupported")
  })
})
