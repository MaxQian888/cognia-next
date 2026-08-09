import type { MigrationArtifact, MigrationVendor } from "./types"

export type ArtifactSupport = "supported" | "shared" | "unsupported"

/** Static capability matrix; runtime probes determine ready vs empty. */
export function artifactSupportFor(
  vendor: MigrationVendor,
  artifact: MigrationArtifact
): ArtifactSupport {
  if (artifact === "memory") return "shared"
  if (vendor === "claude-code" && artifact === "commands") return "shared"
  return "supported"
}
