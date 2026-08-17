import type { MigrationArtifact, MigrationVendor } from "./types"

export type ArtifactSupport = "supported" | "shared" | "unsupported"

/**
 * Static capability matrix; runtime probes decide ready vs empty.
 *
 * Every vendor × artifact pair is spelled out on purpose. This function used
 * to end in `return "supported"`, which meant a vendor added to
 * `MIGRATION_VENDORS` instantly claimed all seven artifacts worked — before a
 * single adapter for it existed. The wizard would then offer imports that
 * silently produced nothing, or worse, produced another vendor's data (see the
 * `previewSkills` fallthrough in `artifacts.ts`).
 *
 * A missing entry now fails closed. Because the outer type is an exhaustive
 * `Record<MigrationVendor, …>`, adding a vendor is a compile error until its
 * row is filled in — which is the point.
 */
const SUPPORT: Record<MigrationVendor, Record<MigrationArtifact, ArtifactSupport>> = {
  "claude-code": {
    settings: "supported",
    sessions: "supported",
    skills: "supported",
    subagents: "supported",
    mcp: "supported",
    // Claude Code's slash commands live in the same tree Cognia already reads.
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
    // Pi's core has no MCP at all — `mcpServers` appears nowhere in its
    // distribution and pi.dev has no MCP page. MCP reaches Pi only through the
    // third-party `pi-mcp-adapter` package, so there is nothing to import from
    // a stock Pi install and claiming otherwise would offer an empty preview.
    mcp: "unsupported",
    commands: "supported",
    // Pi reads the same AGENTS.md / CLAUDE.md chain the other agents do.
    memory: "shared",
  },
}

export function artifactSupportFor(
  vendor: MigrationVendor,
  artifact: MigrationArtifact
): ArtifactSupport {
  return SUPPORT[vendor]?.[artifact] ?? "unsupported"
}
